import { normalizePath } from './pathNormalize.js';

const REPLACEMENT_TTL_MS = 60_000;

/**
 * Tracks /clear in-flight state for active sessions.
 *
 *   - inFlight (Set<sessionId>): sessions whose feed has been wiped and which
 *     are blocked from transcript re-read until a replacement is detected.
 *   - pendingReplacements (Map<cwdKey, {sessionId, ts}>): the next new
 *     transcript in this cwd should be linked as the replacement. Time-boxed.
 *
 * /clear has 4 PID-based detection paths in stateManager — this manager owns
 * the data they read, but does NOT add a 5th detection path.
 */
export class ClearLifecycleManager {
  private inFlight = new Map<string, number>();
  private pendingReplacements = new Map<string, { sessionId: string; timestamp: number }>();

  /** Mark a session as having had its feed cleared (blocks re-read). */
  markCleared(sessionId: string): void {
    this.inFlight.set(sessionId, Date.now());
  }

  /** Is this session currently blocked from transcript re-read?
   *  Auto-expires after REPLACEMENT_TTL_MS so a missed replacement (e.g. claude
   *  ignored /clear, auto-compaction overlapped) doesn't freeze the feed forever. */
  isInFlight(sessionId: string): boolean {
    const ts = this.inFlight.get(sessionId);
    if (ts === undefined) return false;
    if (Date.now() - ts > REPLACEMENT_TTL_MS) {
      console.warn(`[clear-lifecycle] inFlight TTL expired for ${sessionId.slice(0, 8)} — unblocking transcript re-read`);
      this.inFlight.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Called from any /clear detection path once the replacement is observed. */
  completeReplacement(sessionId: string): void {
    this.inFlight.delete(sessionId);
  }

  getInFlightSessions(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Record that /clear was injected into sessionId (via UI). The next new
   *  transcript in the same cwd will be linked as replacement. */
  markPendingReplacement(sessionId: string, cwd: string): void {
    const key = normalizePath(cwd);
    console.log(`[pending-clear] marked: ${sessionId.slice(0, 8)} key="${key}"`);
    this.pendingReplacements.set(key, { sessionId, timestamp: Date.now() });
  }

  /** Consume the pending clear replacement for cwd if it exists and is fresh (<60s). */
  consumePendingReplacement(cwd: string): { sessionId: string } | null {
    const key = normalizePath(cwd);
    const entry = this.pendingReplacements.get(key);
    console.log(`[pending-clear] consume key="${key}" found=${!!entry} keys=[${[...this.pendingReplacements.keys()].join(',')}]`);
    if (!entry) return null;
    this.pendingReplacements.delete(key);
    if (Date.now() - entry.timestamp > REPLACEMENT_TTL_MS) return null;
    return { sessionId: entry.sessionId };
  }
}
