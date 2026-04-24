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
  private sidIndex = new Map<string, string>(); // sessionId → overlordId

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
    this.sidIndex.set(record.lineage.currentSessionId, record.overlordId);
    for (const entry of record.lineage.history) {
      this.sidIndex.set(entry.sessionId, record.overlordId);
    }
  }

  private dropFromIndex(record: OverlordSession): void {
    for (const [sid, ovr] of this.sidIndex) {
      if (ovr === record.overlordId) this.sidIndex.delete(sid);
    }
  }

  loadAll(): void {
    this.active.clear();
    this.archived.clear();
    this.sidIndex.clear();

    this.ensureDir(this.activeDir);
    this.ensureDir(this.archiveDir);

    const loadDir = (dir: string, target: Map<string, OverlordSession>): void => {
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { return; }
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const full = path.join(dir, f);
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const parsed = JSON.parse(raw) as OverlordSession;
          if (parsed?.overlordId && parsed.lineage?.currentSessionId) {
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
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  getByOverlordId(ovrId: string): OverlordSession | undefined {
    return this.active.get(ovrId) ?? this.archived.get(ovrId);
  }

  getBySessionId(sessionId: string): OverlordSession | undefined {
    const ovr = this.sidIndex.get(sessionId);
    if (!ovr) return undefined;
    return this.getByOverlordId(ovr);
  }

  resolveOverlordId(sessionId: string): string | undefined {
    return this.sidIndex.get(sessionId);
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
    const target = this.active.has(ovrId) ? this.active : this.archived;
    target.set(ovrId, merged);
    this.reindex(merged);
    this.scheduleFlush(ovrId);
    return merged;
  }

  /** Patch by sessionId — resolves to overlordId first. */
  patchBySessionId(sessionId: string, partial: Partial<OverlordSession>): OverlordSession | undefined {
    const ovrId = this.sidIndex.get(sessionId);
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
    };
    this.upsertActive(seed);
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
  }

  /** Remove by sessionId (resolved via index). */
  removeBySessionId(sessionId: string): void {
    const ovrId = this.sidIndex.get(sessionId);
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
