import type { WorkerIcon } from '../types.js';

/**
 * Avatar icons chosen at spawn time, queued against the pre-minted ovrId.
 *
 * At spawn there is no OverlordSession record yet — `spawnClaudeSession` only
 * *reserves* an ovrId; the record is created later by `stateManager.addOrUpdate`
 * → `sessionStore.ensureFromLive` once the live Claude session lands. This queue
 * bridges that gap so the icon is applied before the first snapshot goes out
 * (no flash of the default `user` glyph).
 *
 * `peek` deliberately does NOT consume: `addOrUpdate` skips record persistence
 * for phantom sessions, and a phantom tick must not swallow the icon. The entry
 * is dropped only via `clear`, once it has actually been persisted (or when the
 * PTY spawn failed).
 */
export class PendingSpawnIcons {
  /** Matches OvrIdReservation's window — past it the reservation is gone too. */
  static readonly TTL_MS = 5 * 60 * 1000;

  private byOvrId = new Map<string, { icon: WorkerIcon; at: number }>();

  track(ovrId: string, icon: WorkerIcon): void {
    this.prune();
    this.byOvrId.set(ovrId, { icon, at: Date.now() });
  }

  /** Non-consuming read. Stale entries are dropped rather than returned. */
  peek(ovrId: string): WorkerIcon | undefined {
    const entry = this.byOvrId.get(ovrId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > PendingSpawnIcons.TTL_MS) {
      this.byOvrId.delete(ovrId);
      return undefined;
    }
    return entry.icon;
  }

  clear(ovrId: string): void {
    this.byOvrId.delete(ovrId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [ovrId, entry] of this.byOvrId) {
      if (now - entry.at > PendingSpawnIcons.TTL_MS) this.byOvrId.delete(ovrId);
    }
  }
}
