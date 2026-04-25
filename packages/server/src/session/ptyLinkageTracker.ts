import type { WebSocket } from 'ws';

export interface PendingPidEntry { ptySessionId: string; ws: WebSocket }
export interface PendingResumeEntry { ptySessionId: string; ws?: WebSocket; timestamp: number }
export interface PendingCloneInfo { name: string; originalSessionId: string }

/**
 * Tracks PTY spawns waiting to be linked to their live Claude session.
 *
 * Three independent in-flight registries:
 *  - byPid:       PTY spawned, waiting for the watcher to observe a session
 *                 with this PID. Populated by ptyManager `pid-ready`.
 *  - byResumeId:  PTY spawned with `--resume <sid>`. Linked when the watcher
 *                 sees a session whose sid matches (ConPTY fallback path).
 *  - cloneInfo:   PTY spawned with `--fork-session`. The clone's name +
 *                 original-sid carried here, applied once the new sid lands.
 *
 * Lifecycle: write at spawn → read+delete when watcher observes the session.
 * Pure in-memory state; no IO, no persistence.
 */
export class PtyLinkageTracker {
  private _byPid = new Map<number, PendingPidEntry>();
  private _byResumeId = new Map<string, PendingResumeEntry>();
  private _cloneInfo = new Map<string, PendingCloneInfo>();

  /** Read-only views. Used for `.has()` / `.get()` reads in hot paths. */
  get byPid(): ReadonlyMap<number, PendingPidEntry> { return this._byPid; }
  get byResumeId(): ReadonlyMap<string, PendingResumeEntry> { return this._byResumeId; }
  get cloneInfo(): ReadonlyMap<string, PendingCloneInfo> { return this._cloneInfo; }

  // ── PID lifecycle ──
  trackPid(pid: number, entry: PendingPidEntry): void { this._byPid.set(pid, entry); }
  consumePid(pid: number): PendingPidEntry | undefined {
    const e = this._byPid.get(pid);
    if (e) this._byPid.delete(pid);
    return e;
  }
  hasPid(pid: number): boolean { return this._byPid.has(pid); }

  // ── Resume lifecycle ──
  trackResume(resumeSessionId: string, entry: PendingResumeEntry): void { this._byResumeId.set(resumeSessionId, entry); }
  consumeResume(resumeSessionId: string): PendingResumeEntry | undefined {
    const e = this._byResumeId.get(resumeSessionId);
    if (e) this._byResumeId.delete(resumeSessionId);
    return e;
  }
  hasResume(resumeSessionId: string): boolean { return this._byResumeId.has(resumeSessionId); }
  /** True if any resume is in flight. Used by sessionEventHandlers to gate
   *  aggressive autonomous linking until pending resumes resolve. */
  hasAnyResume(): boolean { return this._byResumeId.size > 0; }

  // ── Clone-info lifecycle ──
  trackCloneInfo(ptySessionId: string, info: PendingCloneInfo): void { this._cloneInfo.set(ptySessionId, info); }
  consumeCloneInfo(ptySessionId: string): PendingCloneInfo | undefined {
    const e = this._cloneInfo.get(ptySessionId);
    if (e) this._cloneInfo.delete(ptySessionId);
    return e;
  }
  /** Remove without returning. Used by wsHandler clone-spawn rollback path. */
  dropCloneInfo(ptySessionId: string): void { this._cloneInfo.delete(ptySessionId); }

  // ── PTY-exit cleanup (called from ptyEvents on `exit`) ──
  /** Drop the first PID entry pointing at this PTY (at most one expected). */
  removePidEntriesByPty(ptySessionId: string): void {
    for (const [pid, entry] of this._byPid) {
      if (entry.ptySessionId === ptySessionId) { this._byPid.delete(pid); break; }
    }
  }
  /** Drop the first resume entry pointing at this PTY (at most one expected). */
  removeResumeEntriesByPty(ptySessionId: string): void {
    for (const [resumeId, entry] of this._byResumeId) {
      if (entry.ptySessionId === ptySessionId) { this._byResumeId.delete(resumeId); break; }
    }
  }
}
