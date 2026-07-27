import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  OverlordSession,
  Session,
  LineageEntry,
  ArchivedTranscript,
  PullRequestSnapshot,
} from '../types.js';
import { ensureShadow, removeShadowDir } from './transcriptShadow.js';

function defaultBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, '.claude', 'overlord');
}

const DEFAULT_DEBOUNCE_MS = 200;

function isValidId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id.length > 0 && id.length <= 200;
}

export interface SessionStoreOptions {
  baseDir?: string;
  debounceMs?: number;
}

export interface ArchiveSnapshot {
  roomId: string;
  name: string;
  gitBranch?: string;
  pullRequest?: PullRequestSnapshot;
  transcripts: ArchivedTranscript[];
}

/**
 * Durable store for OverlordSession records. One file per overlordId.
 *
 * Layout:
 *   {baseDir}/overlord-sessions/{overlordId}.json          active
 *   {baseDir}/overlord-sessions-archive/{overlordId}.json  archived
 *
 * Secondary index `sessionId → overlordId` is built on load and maintained on
 * every mutation so callers that only know a Claude sessionId can still find
 * the record.
 *
 * Writes:
 *   - Patches merge into in-memory Map immediately.
 *   - Each overlordId has a Promise chain serializing writes.
 *   - A per-overlord debounce timer coalesces rapid patches into one flush.
 *   - Flush is atomic: tmp + rename.
 *   - Removal and archive/unarchive are synchronous to keep dir state authoritative.
 */
export class SessionStore {
  private active = new Map<string, OverlordSession>();
  private archived = new Map<string, OverlordSession>();
  // Two-tier sid index: active sids resolve before archived. Single-map
  // priority broke when archived loaded after active and silently overwrote
  // the live mapping (repro: `getBySessionId(sid)` returned an archived
  // ovrId for a sid still owned by an active record's lineage, which then
  // got "reused" as a fresh active record on the next compose).
  private sidIndexActive = new Map<string, string>();    // sessionId → overlordId (active)
  private sidIndexArchived = new Map<string, string>();  // sessionId → overlordId (archived)

  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writeChain = new Map<string, Promise<void>>();
  private dirty = new Set<string>();

  private readonly baseDir: string;
  private readonly debounceMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? defaultBaseDir();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  private get activeDir(): string { return path.join(this.baseDir, 'overlord-sessions'); }
  private get archiveDir(): string { return path.join(this.baseDir, 'overlord-sessions-archive'); }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private activePath(ovrId: string): string { return path.join(this.activeDir, `${ovrId}.json`); }
  private archivedPath(ovrId: string): string { return path.join(this.archiveDir, `${ovrId}.json`); }

  private reindex(record: OverlordSession): void {
    // Clear any stale entries for this ovrId in both maps first, then write
    // to the correct map based on current active/archived status.
    this.dropFromIndex(record);
    const isArchived = this.archived.has(record.overlordId);
    const sids = [record.lineage.currentSessionId, ...record.lineage.history.map(h => h.sessionId)];
    for (const sid of sids) {
      if (isArchived) {
        // Active always wins — only index archived sids that no active record claims.
        // (Stale archived dupes can share sids with a live lineage; do not let
        // them shadow the active mapping that mint guards rely on.)
        if (!this.sidIndexActive.has(sid)) this.sidIndexArchived.set(sid, record.overlordId);
      } else {
        this.sidIndexActive.set(sid, record.overlordId);
        // If this sid was previously held by some archived dupe, drop that mapping —
        // we now have an active owner and that's the only truth callers should see.
        if (this.sidIndexArchived.get(sid) !== record.overlordId) this.sidIndexArchived.delete(sid);
      }
    }
  }

  private dropFromIndex(record: OverlordSession): void {
    for (const [sid, ovr] of this.sidIndexActive) {
      if (ovr === record.overlordId) this.sidIndexActive.delete(sid);
    }
    for (const [sid, ovr] of this.sidIndexArchived) {
      if (ovr === record.overlordId) this.sidIndexArchived.delete(sid);
    }
  }

  loadAll(): void {
    this.active.clear();
    this.archived.clear();
    this.sidIndexActive.clear();
    this.sidIndexArchived.clear();

    this.ensureDir(this.activeDir);
    this.ensureDir(this.archiveDir);

    const loadDir = (dir: string, target: Map<string, OverlordSession>): void => {
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { return; }
      // Sweep leftover *.tmp files from crashed writes — they accumulate and
      // get mistaken for live records by casual `ls` inspection.
      for (const f of files) {
        if (!f.endsWith('.tmp')) continue;
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const full = path.join(dir, f);
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const parsed = JSON.parse(raw) as OverlordSession;
          if (parsed?.overlordId && parsed.lineage?.currentSessionId) {
            // Scrub self-referential replacedBy left by old transferSessionState
            // writes. A record whose currentSessionId === replacedBy is hidden
            // forever by getSnapshot's filter.
            if (parsed.replacedBy && parsed.replacedBy === parsed.lineage.currentSessionId) {
              console.warn(`[sessionStore] scrubbing self-referential replacedBy on ${parsed.overlordId}`);
              parsed.replacedBy = undefined;
              try {
                const tmp = `${full}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8');
                fs.renameSync(tmp, full);
              } catch { /* best-effort */ }
            }
            target.set(parsed.overlordId, parsed);
            this.reindex(parsed);
          } else {
            console.warn(`[sessionStore] skip ${f}: missing overlordId or lineage`);
          }
        } catch (err) {
          console.warn(`[sessionStore] skip malformed ${f}: ${(err as Error).message}`);
        }
      }
    };

    loadDir(this.activeDir, this.active);
    loadDir(this.archiveDir, this.archived);

    // One-shot migration: when the JIRA-key extractor switched from bare-text
    // matching to URL-only matching, previously-persisted keys that came from
    // branch names or commit messages need to be cleared. Records re-populate
    // on the next transcript poll using the new (URL-only) extractor.
    const migrationMarker = path.join(path.dirname(this.activeDir), '.jira-keys-url-migration-v1');
    if (!fs.existsSync(migrationMarker)) {
      let scrubbed = 0;
      for (const [ovrId, rec] of this.active) {
        if (rec.jiraKeys && rec.jiraKeys.length > 0) {
          rec.jiraKeys = undefined;
          this.dirty.add(ovrId);
          this.scheduleFlush(ovrId);
          scrubbed++;
        }
      }
      for (const rec of this.archived.values()) {
        if (rec.jiraKeys) rec.jiraKeys = undefined;
      }
      try { fs.writeFileSync(migrationMarker, new Date().toISOString()); } catch { /* best-effort */ }
      if (scrubbed > 0) console.log(`[sessionStore] cleared bare-text jiraKeys on ${scrubbed} record(s) (URL-only migration)`);
    }
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  getByOverlordId(ovrId: string): OverlordSession | undefined {
    return this.active.get(ovrId) ?? this.archived.get(ovrId);
  }

  getBySessionId(sessionId: string): OverlordSession | undefined {
    const ovr = this.sidIndexActive.get(sessionId) ?? this.sidIndexArchived.get(sessionId);
    if (!ovr) return undefined;
    return this.getByOverlordId(ovr);
  }

  /** Active records only — use this for mint guards / new-session attach lookups
   *  so a stale archived lineage doesn't get "reused" as a fresh active record. */
  resolveOverlordId(sessionId: string): string | undefined {
    return this.sidIndexActive.get(sessionId);
  }

  /** Active first, then archived — for callers that must locate a sid anywhere. */
  resolveOverlordIdAny(sessionId: string): string | undefined {
    return this.sidIndexActive.get(sessionId) ?? this.sidIndexArchived.get(sessionId);
  }

  /** Archived tier only — for archive routes (view/restore/unarchive/delete).
   *  sidIndexArchived drops any sid an active record claims (active-wins), so a
   *  live dupe minted after archiving (e.g. a failed resume) would shadow the
   *  archive entry via getBySessionId; scan archived lineages directly instead. */
  getArchivedBySessionId(sessionId: string): OverlordSession | undefined {
    const ovr = this.sidIndexArchived.get(sessionId);
    if (ovr) return this.archived.get(ovr);
    for (const rec of this.archived.values()) {
      if (rec.lineage.currentSessionId === sessionId) return rec;
      if (rec.lineage.history.some(h => h.sessionId === sessionId)) return rec;
    }
    return undefined;
  }

  listActive(): OverlordSession[] { return [...this.active.values()]; }
  listArchived(): OverlordSession[] { return [...this.archived.values()]; }
  listAll(): OverlordSession[] { return [...this.active.values(), ...this.archived.values()]; }
  listArchivedByCwd(cwd: string): OverlordSession[] {
    return this.listArchived().filter(s => s.cwd === cwd);
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  /** Synchronous insert/overwrite for an ACTIVE record. Used by migration. */
  upsertActive(record: OverlordSession): void {
    if (!isValidId(record.overlordId)) throw new Error(`invalid overlordId: ${record.overlordId}`);
    if (!record.lineage?.currentSessionId) throw new Error(`missing lineage.currentSessionId for ${record.overlordId}`);
    // If the same ovrId was previously archived, remove the archive record first.
    if (this.archived.has(record.overlordId)) {
      this.archived.delete(record.overlordId);
      try { fs.unlinkSync(this.archivedPath(record.overlordId)); } catch { /* ignore */ }
    }
    this.active.set(record.overlordId, record);
    this.reindex(record);
    this.flushSync(record.overlordId, 'active');
  }

  /** Synchronous insert for an ARCHIVED record. Used by migration. */
  upsertArchived(record: OverlordSession): void {
    if (!isValidId(record.overlordId)) throw new Error(`invalid overlordId: ${record.overlordId}`);
    if (!record.archive) throw new Error(`missing archive block for ${record.overlordId}`);
    if (this.active.has(record.overlordId)) {
      this.active.delete(record.overlordId);
      try { fs.unlinkSync(this.activePath(record.overlordId)); } catch { /* ignore */ }
    }
    this.archived.set(record.overlordId, record);
    this.reindex(record);
    this.flushSync(record.overlordId, 'archive');
  }

  /** Merge partial fields. Works on active or archived records. Preserves immutable keys. */
  patch(ovrId: string, partial: Partial<OverlordSession>): OverlordSession | undefined {
    const existing = this.active.get(ovrId) ?? this.archived.get(ovrId);
    if (!existing) return undefined;
    const merged: OverlordSession = {
      ...existing,
      ...partial,
      overlordId: existing.overlordId,
      lineage: partial.lineage ?? existing.lineage,
    };
    // Refuse to write self-referential replacedBy. A record whose
    // currentSessionId === replacedBy is hidden forever by getSnapshot.
    // Catches stray writes from callers that pass the wrong sid.
    if (merged.replacedBy && merged.replacedBy === merged.lineage?.currentSessionId) {
      console.warn(`[sessionStore] dropping self-referential replacedBy on ${ovrId} (sid=${merged.replacedBy.slice(0, 8)})`);
      merged.replacedBy = undefined;
    }
    const target = this.active.has(ovrId) ? this.active : this.archived;
    target.set(ovrId, merged);
    this.reindex(merged);
    this.scheduleFlush(ovrId);
    return merged;
  }

  /** Patch by sessionId — resolves to overlordId first. */
  patchBySessionId(sessionId: string, partial: Partial<OverlordSession>): OverlordSession | undefined {
    const ovrId = this.resolveOverlordIdAny(sessionId);
    if (!ovrId) return undefined;
    return this.patch(ovrId, partial);
  }

  /**
   * Attach a new Claude sessionId to an existing overlord (e.g. after /clear or /compact).
   * Appends to history + updates currentSessionId atomically. No-op if sessionId already current.
   */
  attachSession(ovrId: string, entry: LineageEntry): OverlordSession | undefined {
    const existing = this.active.get(ovrId) ?? this.archived.get(ovrId);
    if (!existing) return undefined;
    if (existing.lineage.currentSessionId === entry.sessionId) return existing;

    const history = [...existing.lineage.history];
    if (!history.some(h => h.sessionId === entry.sessionId)) history.push(entry);
    const merged: OverlordSession = {
      ...existing,
      lineage: { currentSessionId: entry.sessionId, history },
    };
    const target = this.active.has(ovrId) ? this.active : this.archived;
    target.set(ovrId, merged);
    this.reindex(merged);
    this.scheduleFlush(ovrId);
    if (entry.transcriptPath) ensureShadow(ovrId, entry.sessionId, entry.transcriptPath);
    return merged;
  }

  /**
   * Ensure an active record exists for a live Session. Seeds from durable fields
   * if the overlord is new. Returns the (possibly-existing) record.
   *
   * Also maintains the lineage when StateManager sees a new sessionId attach to
   * an existing overlordId — e.g. /clear or resume.
   */
  ensureFromLive(live: Session): OverlordSession {
    const ovrId = live.overlordId;
    if (!ovrId) throw new Error('ensureFromLive requires live.overlordId');

    const existing = this.active.get(ovrId) ?? this.archived.get(ovrId);
    if (existing) {
      if (existing.lineage.currentSessionId !== live.sessionId) {
        return this.attachSession(ovrId, {
          sessionId: live.sessionId,
          attachedAt: Date.now(),
          transcriptPath: live.transcriptPath,
          reason: live.resumedFrom ? 'resume' : 'clear',
        }) ?? existing;
      }
      return existing;
    }

    const seed: OverlordSession = {
      overlordId: ovrId,
      cwd: live.cwd,
      startedAt: live.startedAt,
      color: live.color,
      icon: live.icon,
      proposedName: live.proposedName,
      lineage: {
        currentSessionId: live.sessionId,
        history: live.sessionHistory?.length
          ? live.sessionHistory.map((h): LineageEntry => ({
              sessionId: h.sessionId,
              attachedAt: h.attachedAt,
              transcriptPath: h.sessionId === live.sessionId ? live.transcriptPath : undefined,
              reason: h.sessionId === live.sessionId ? 'initial' : undefined,
            }))
          : [{
              sessionId: live.sessionId,
              attachedAt: live.startedAt,
              transcriptPath: live.transcriptPath,
              reason: live.resumedFrom ? 'resume' : 'initial',
            }],
      },
      provider: live.provider,
      providerSessionId: live.providerSessionId,
      sessionType: live.sessionType ?? 'plain',
      model: live.model,
      slug: live.slug,
      resumedFrom: live.resumedFrom,
      replacedBy: live.replacedBy,
      bridgeMarker: live.bridgeMarker,
      bridgePipeName: live.bridgePipeName,
      historyOnly: live.historyOnly,
      userAccepted: live.userAccepted,
      lastActivity: live.lastActivity,
      lastMessage: live.lastMessage,
      intent: live.intent,
      jiraKeys: live.jiraKeys,
      skillsUsed: live.skillsUsed,
    };
    this.upsertActive(seed);
    if (live.transcriptPath) ensureShadow(ovrId, live.sessionId, live.transcriptPath);
    return seed;
  }

  /** Move record from active → archived dir. Writes `archive` snapshot block. Sync. */
  archive(ovrId: string, snapshot: ArchiveSnapshot): OverlordSession | undefined {
    const rec = this.active.get(ovrId);
    if (!rec) return this.archived.get(ovrId);  // idempotent: already archived
    const archivedRec: OverlordSession = {
      ...rec,
      archive: {
        archivedAt: new Date().toISOString(),
        roomId: snapshot.roomId,
        name: snapshot.name,
        gitBranch: snapshot.gitBranch,
        pullRequest: snapshot.pullRequest,
        transcripts: snapshot.transcripts,
      },
    };
    // Cancel any pending debounce on the active path — we're about to delete that file.
    const timer = this.flushTimers.get(ovrId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(ovrId); }
    this.dirty.delete(ovrId);

    this.active.delete(ovrId);
    this.archived.set(ovrId, archivedRec);
    this.reindex(archivedRec); // moves sids from active→archived index
    this.flushSync(ovrId, 'archive');
    try { fs.unlinkSync(this.activePath(ovrId)); } catch { /* ignore */ }
    return archivedRec;
  }

  /** Move record from archived → active dir. Clears `archive` block. Sync. */
  unarchive(ovrId: string): OverlordSession | undefined {
    const rec = this.archived.get(ovrId);
    if (!rec) return this.active.get(ovrId);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { archive: _drop, ...rest } = rec;
    const restored: OverlordSession = rest;

    const timer = this.flushTimers.get(ovrId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(ovrId); }
    this.dirty.delete(ovrId);

    this.archived.delete(ovrId);
    this.active.set(ovrId, restored);
    this.reindex(restored); // moves sids from archived→active index
    this.flushSync(ovrId, 'active');
    try { fs.unlinkSync(this.archivedPath(ovrId)); } catch { /* ignore */ }
    return restored;
  }

  /** Delete file + in-memory entry. Cancels pending debounce. Synchronous. */
  remove(ovrId: string): void {
    const timer = this.flushTimers.get(ovrId);
    if (timer) { clearTimeout(timer); this.flushTimers.delete(ovrId); }
    this.dirty.delete(ovrId);
    const rec = this.active.get(ovrId) ?? this.archived.get(ovrId);
    if (rec) this.dropFromIndex(rec);
    this.active.delete(ovrId);
    this.archived.delete(ovrId);
    try { fs.unlinkSync(this.activePath(ovrId)); } catch { /* not found is fine */ }
    try { fs.unlinkSync(this.archivedPath(ovrId)); } catch { /* not found is fine */ }
    removeShadowDir(ovrId);
  }

  /** Remove by sessionId (resolved via index). */
  removeBySessionId(sessionId: string): void {
    const ovrId = this.resolveOverlordIdAny(sessionId);
    if (ovrId) this.remove(ovrId);
  }

  async flushAll(): Promise<void> {
    const ids = [...this.flushTimers.keys()];
    for (const id of ids) {
      const timer = this.flushTimers.get(id);
      if (timer) { clearTimeout(timer); this.flushTimers.delete(id); }
      this.enqueueFlush(id);
    }
    await Promise.all([...this.writeChain.values()]);
  }

  // ── private write helpers ─────────────────────────────────────────────────

  private targetPathFor(ovrId: string): string {
    return this.active.has(ovrId) ? this.activePath(ovrId) : this.archivedPath(ovrId);
  }

  private scheduleFlush(ovrId: string): void {
    this.dirty.add(ovrId);
    const existing = this.flushTimers.get(ovrId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.flushTimers.delete(ovrId);
      this.enqueueFlush(ovrId);
    }, this.debounceMs);
    this.flushTimers.set(ovrId, timer);
  }

  private enqueueFlush(ovrId: string): void {
    if (!this.dirty.has(ovrId)) return;
    const prev = this.writeChain.get(ovrId) ?? Promise.resolve();
    const next = prev.then(() => this.writeOnce(ovrId));
    this.writeChain.set(ovrId, next.finally(() => {
      if (this.writeChain.get(ovrId) === next) this.writeChain.delete(ovrId);
    }));
  }

  private async writeOnce(ovrId: string): Promise<void> {
    const record = this.active.get(ovrId) ?? this.archived.get(ovrId);
    if (!record) { this.dirty.delete(ovrId); return; }
    this.dirty.delete(ovrId);
    try {
      const target = this.targetPathFor(ovrId);
      this.ensureDir(path.dirname(target));
      const tmp = `${target}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
      await fs.promises.rename(tmp, target);
    } catch (err) {
      console.warn(`[sessionStore] write failed for ${ovrId}: ${(err as Error).message}`);
      this.dirty.add(ovrId);
    }
  }

  private flushSync(ovrId: string, which: 'active' | 'archive'): void {
    const record = which === 'active' ? this.active.get(ovrId) : this.archived.get(ovrId);
    if (!record) return;
    this.dirty.delete(ovrId);
    try {
      const target = which === 'active' ? this.activePath(ovrId) : this.archivedPath(ovrId);
      this.ensureDir(path.dirname(target));
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
    } catch (err) {
      console.warn(`[sessionStore] sync write failed for ${ovrId}: ${(err as Error).message}`);
      this.dirty.add(ovrId);
    }
  }
}

export const sessionStore = new SessionStore();

/**
 * Scrub stale `replacedBy` pointers on active OverlordSession records.
 *
 * Two failure modes:
 *  - **self-referential** — `replacedBy === lineage.currentSessionId`. A
 *    record claims it was replaced by its own active sid. Typically a stale
 *    write from an old transferSessionState. `getSnapshot`'s replacedBy
 *    filter would otherwise hide the session forever.
 *  - **orphan-successor** — `replacedBy = sid-X` but `sid-X` does not appear
 *    in ANY active record's `lineage.history`. The successor was promoted
 *    elsewhere (different ovrId) and the old pointer was never cleared, or
 *    the successor was deleted. Without this scrub the record stays hidden
 *    while its sid runs as a live process (the "PS-A Vorin twin" repro).
 *
 * Safe to call repeatedly. One walk over active records plus one Set build.
 * Endpoint- and boot-triggered, NOT per-tick.
 */
export function scrubReplacedBy(): { selfRef: string[]; orphanSuccessor: string[] } {
  const active = sessionStore.listActive();
  const selfRef: string[] = [];
  const orphanSuccessor: string[] = [];
  const allHistorySids = new Set<string>();
  for (const r of active) {
    for (const h of r.lineage?.history ?? []) allHistorySids.add(h.sessionId);
  }
  for (const rec of active) {
    if (!rec.replacedBy) continue;
    if (rec.replacedBy === rec.lineage?.currentSessionId) {
      sessionStore.patch(rec.overlordId, { replacedBy: undefined });
      selfRef.push(rec.overlordId);
      continue;
    }
    if (!allHistorySids.has(rec.replacedBy)) {
      sessionStore.patch(rec.overlordId, { replacedBy: undefined });
      orphanSuccessor.push(rec.overlordId);
    }
  }
  return { selfRef, orphanSuccessor };
}
