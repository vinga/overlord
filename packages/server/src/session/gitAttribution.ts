import type { ActivityItem } from '../types.js';

const CHECKOUT_RE = /\bgit\s+(?:-[cC]\s+\S+\s+)*(?:checkout|switch|worktree)\b/;
const ACTIVE_WINDOW_MS = 60_000;

/** Scan the tail of an activityFeed for the most recent git checkout/switch/worktree Bash call. Returns 0 if none. */
function findLatestCheckoutTs(feed: ActivityItem[] | undefined): number {
  if (!feed || feed.length === 0) return 0;
  const start = Math.max(0, feed.length - 30);
  let latest = 0;
  for (let i = feed.length - 1; i >= start; i--) {
    const item = feed[i];
    if (item.kind !== 'tool' || item.toolName !== 'Bash') continue;
    let cmd = '';
    if (item.inputJson) {
      try {
        const parsed = JSON.parse(item.inputJson) as { command?: unknown };
        if (typeof parsed.command === 'string') cmd = parsed.command;
      } catch { /* fall through */ }
    }
    if (!cmd) cmd = item.content ?? '';
    if (!CHECKOUT_RE.test(cmd)) continue;
    const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}

interface AttributionInput {
  overlordId: string;
  state: string;
  lastActivity: string;
  gitBranch?: string;
  activityFeed?: ActivityItem[];
}

/**
 * Per-session git branch attribution.
 *
 *   Rule A (initial capture) — if a session has no branch recorded yet
 *     and it is currently active, adopt the room's branch.
 *   Rule B (update on checkout) — scan recent Bash calls for
 *     checkout/switch/worktree; if a newer one is found since last seen,
 *     adopt the room's branch.
 *   Otherwise: keep previously recorded branch (sticky).
 */
export class GitAttribution {
  private lastCheckoutSeenAt = new Map<string, number>();

  attribute(session: AttributionInput, roomBranch: string | undefined, now: number = Date.now()): string | undefined {
    let nextBranch: string | undefined = session.gitBranch;

    // Rule B
    const latestCheckoutAt = findLatestCheckoutTs(session.activityFeed);
    if (latestCheckoutAt > 0) {
      const lastSeen = this.lastCheckoutSeenAt.get(session.overlordId) ?? 0;
      if (latestCheckoutAt > lastSeen) {
        this.lastCheckoutSeenAt.set(session.overlordId, latestCheckoutAt);
        if (roomBranch) nextBranch = roomBranch;
      }
    }

    // Rule A
    if (!nextBranch && roomBranch) {
      const isActive = session.state !== 'closed'
        && now - new Date(session.lastActivity).getTime() < ACTIVE_WINDOW_MS;
      if (isActive) nextBranch = roomBranch;
    }

    return nextBranch;
  }
}
