import { normalizePath } from './pathNormalize.js';

const RESUME_TTL_MS = 60_000;
const FRESH_PTY_TTL_MS = 5 * 60 * 1000;

interface ResumeEntry { resumeSessionId: string; timestamp: number }
interface HydrateRecord {
  overlordId: string;
  lineage: { currentSessionId: string };
  pendingResume?: { cwd: string; at: number };
}

/**
 * Owns all "PTY spawn / resume in-flight" state.
 *
 * Per CLAUDE.md: pending resume is marker-keyed first, cwd-keyed as fallback.
 * Cwd-keyed alone loses the target on the second concurrent resume — both
 * keys still exist here. Callers consume marker first, cwd second.
 *
 * Persistence to sessionStore is the caller's responsibility; this tracker
 * only owns in-memory state.
 */
export class PtyResumeTracker {
  private pendingResumes = new Map<string, ResumeEntry>();
  private pendingResumesByMarker = new Map<string, ResumeEntry>();
  private pendingPtySpawns = new Map<string, number>();
  /**
   * cwd → ptyId for the most-recently-tracked fresh PTY spawn in that directory.
   * Allows resolving the reserved ovrId when the session file first appears without
   * its --name field (Claude writes {pid}.json before populating `name`).
   */
  private pendingPtySpawnId = new Map<string, string>();
  /**
   * ptyIds spawned as FRESH sessions (terminal:start, not terminal:resume),
   * mapped to insertion timestamp for TTL cleanup. Used by addOrUpdate to
   * skip the cwd-keyed pendingResumes lookup and prevent stale resume state
   * from contaminating an unrelated fresh spawn. Entries are not consumed
   * on lookup because a single PTY may trigger multiple addOrUpdate calls.
   */
  private freshPtySpawns = new Map<string, number>();

  trackResume(cwd: string, resumeSessionId: string): { key: string; ts: number } {
    const key = normalizePath(cwd);
    const now = Date.now();
    this.pendingResumes.set(key, { resumeSessionId, timestamp: now });
    return { key, ts: now };
  }

  trackResumeByMarker(ptyId: string, resumeSessionId: string): void {
    const now = Date.now();
    this.pendingResumesByMarker.set(ptyId, { resumeSessionId, timestamp: now });
    for (const [key, entry] of this.pendingResumesByMarker) {
      if (now - entry.timestamp > RESUME_TTL_MS) this.pendingResumesByMarker.delete(key);
    }
  }

  consumeResumeByMarker(ptyId: string): string | undefined {
    const entry = this.pendingResumesByMarker.get(ptyId);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > RESUME_TTL_MS) {
      this.pendingResumesByMarker.delete(ptyId);
      return undefined;
    }
    this.pendingResumesByMarker.delete(ptyId);
    return entry.resumeSessionId;
  }

  hasResume(cwd: string): boolean {
    const entry = this.pendingResumes.get(normalizePath(cwd));
    return entry != null && Date.now() - entry.timestamp < RESUME_TTL_MS;
  }

  getResumeTarget(cwd: string): string | undefined {
    const entry = this.pendingResumes.get(normalizePath(cwd));
    if (entry && Date.now() - entry.timestamp < RESUME_TTL_MS) return entry.resumeSessionId;
    return undefined;
  }

  /** Returns the raw entry without TTL filtering — used by addOrUpdate. */
  peekResumeEntry(cwd: string): ResumeEntry | undefined {
    return this.pendingResumes.get(normalizePath(cwd));
  }

  /** Drops the cwd-keyed entry. Returns the resumeSessionId that was stored, or undefined. */
  clearResume(cwd: string): string | undefined {
    const key = normalizePath(cwd);
    const entry = this.pendingResumes.get(key);
    if (!entry) return undefined;
    this.pendingResumes.delete(key);
    return entry.resumeSessionId;
  }

  /** Mark a PTY spawn pending. If ptySessionId is provided and a stale resume
   *  in this cwd exists, returns its sessionId (caller must clear persistence). */
  trackPtySpawn(cwd: string, ptySessionId?: string): { staleResumeCleared?: string } {
    const key = normalizePath(cwd);
    const now = Date.now();
    this.pendingPtySpawns.set(key, now);
    if (!ptySessionId) return {};
    this.freshPtySpawns.set(ptySessionId, now);
    this.pendingPtySpawnId.set(key, ptySessionId);
    for (const [k, ts] of this.freshPtySpawns) {
      if (now - ts > FRESH_PTY_TTL_MS) this.freshPtySpawns.delete(k);
    }
    const stale = this.pendingResumes.get(key);
    if (!stale) return {};
    this.pendingResumes.delete(key);
    return { staleResumeCleared: stale.resumeSessionId };
  }

  hasPtySpawn(cwd: string): boolean {
    return this.pendingPtySpawns.has(normalizePath(cwd));
  }

  getPtySpawnTs(cwd: string): number | undefined {
    return this.pendingPtySpawns.get(normalizePath(cwd));
  }

  /** Returns the ptyId registered for a pending spawn in this cwd, if any. */
  getPtyIdForCwd(cwd: string): string | undefined {
    return this.pendingPtySpawnId.get(normalizePath(cwd));
  }

  consumePtySpawn(cwd: string): void {
    const key = normalizePath(cwd);
    this.pendingPtySpawns.delete(key);
    this.pendingPtySpawnId.delete(key);
  }

  isFreshSpawn(ptyId: string): boolean {
    return this.freshPtySpawns.has(ptyId);
  }

  consumeFreshSpawn(ptyId: string): void {
    this.freshPtySpawns.delete(ptyId);
  }

  /** Hydrate cwd-keyed pendingResumes from sessionStore on boot.
   *  Returns ovrIds whose pendingResume expired and should be cleared in storage. */
  hydrate(records: Iterable<HydrateRecord>, now: number = Date.now()): { expiredOvrIds: string[] } {
    const expired: string[] = [];
    for (const rec of records) {
      const pr = rec.pendingResume;
      if (!pr) continue;
      if (now - pr.at >= RESUME_TTL_MS) {
        expired.push(rec.overlordId);
        continue;
      }
      this.pendingResumes.set(pr.cwd, {
        resumeSessionId: rec.lineage.currentSessionId,
        timestamp: pr.at,
      });
    }
    return { expiredOvrIds: expired };
  }
}
