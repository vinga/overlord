import type { ActivityItem } from '../types';

/** Ceiling on items the panel keeps after they slide out of the snapshot tail.
 *  The server sends only the last ~10 (stateManager SNAPSHOT_FEED_TAIL) to keep the
 *  WS payload small; this keeps what the user already saw on screen, client-side,
 *  bounded so a day-long session can't grow the DOM / heap without limit. Past it
 *  the "· · ·" load-older button takes over, as before. */
export const RETAINED_FEED_MAX = 150;
const RETAINED_TRIM_CHUNK = 30;

/** Identity that survives a re-sent snapshot. Not `content`: an assistant message
 *  streams and a tool row gains its result between ticks. Duplicates (parallel
 *  tool calls share a timestamp) are disambiguated by matching runs, not keys. */
function itemKey(it: ActivityItem): string {
  return `${it.timestamp ?? ''}|${it.kind}|${it.role ?? ''}|${it.toolName ?? ''}`;
}

/** True when `a.slice(i)` and `b` agree on every overlapping position. */
function runMatches(a: ActivityItem[], i: number, b: ActivityItem[]): boolean {
  const n = Math.min(a.length - i, b.length);
  if (n <= 0) return false;
  for (let j = 0; j < n; j++) {
    if (itemKey(a[i + j]) !== itemKey(b[j])) return false;
  }
  return true;
}

export interface RetainResult {
  retained: ActivityItem[];
  /** prev and next share no run — more items arrived in one tick than the tail
   *  holds. Whatever fell in between is unknown; the caller refetches. */
  gap: boolean;
}

/** Fold the items that fell off the front of the snapshot tail into `retained`.
 *  Returns the same `retained` reference when nothing changed, so memos keyed on
 *  it hold across the (common) ticks where the tail only grew at the end. */
export function retainEvicted(
  prev: ActivityItem[] | undefined,
  next: ActivityItem[] | undefined,
  retained: ActivityItem[],
  max = RETAINED_FEED_MAX,
): RetainResult {
  if (!prev || prev.length === 0 || !next || next.length === 0) return { retained, gap: false };

  let combined = retained;
  let i = 0;
  while (i < prev.length && !runMatches(prev, i, next)) i++;
  if (i < prev.length) {
    if (i > 0) combined = [...retained, ...prev.slice(0, i)];
  } else {
    // The tail may have stretched back instead (it reaches for the last user
    // message): next then starts before prev and contains it.
    let k = 1;
    while (k < next.length && !runMatches(next, k, prev)) k++;
    if (k >= next.length) return { retained, gap: true };
    // Drop the retained suffix the server is sending again (at most the k
    // re-included items — wider would false-match parallel tools' shared keys).
    let overlap = Math.min(combined.length, k);
    for (; overlap > 0; overlap--) {
      if (runMatches(combined, combined.length - overlap, next.slice(k - overlap, k))) break;
    }
    if (overlap > 0) combined = combined.slice(0, combined.length - overlap);
  }

  // Trim in chunks: FeedSegments keys expand state by segment index, so every
  // front drop shifts it. One drop per ~RETAINED_TRIM_CHUNK evictions, not per tick.
  if (combined.length > max) combined = combined.slice(combined.length - (max - Math.min(RETAINED_TRIM_CHUNK, Math.floor(max / 5))));
  return { retained: combined, gap: false };
}
