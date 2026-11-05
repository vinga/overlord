import type { Session } from '../types';

// Ordering is keyed by overlordId (stable across /clear and --resume) so
// resuming a session doesn't reshuffle its slot. Falls back to sessionId
// for any session without an overlordId.
export const orderKey = (s: Session): string => s.overlordId ?? s.sessionId;

// Stable fallback when no custom order exists: oldest startedAt first.
// Idle time is intentionally NOT used — workers must not reshuffle as
// closed sessions age past arbitrary thresholds.
const byStartedAt = (a: Session, b: Session): number =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;

// Dedup by overlordId: a single lineage (same overlordId across resumes)
// should render as one worker. Prefer an active session over closed, then
// most recent by startedAt.
function dedupByOverlord(sessions: Session[]): Session[] {
  const bestByOvr = new Map<string, Session>();
  for (const s of sessions) {
    const key = orderKey(s);
    const cur = bestByOvr.get(key);
    if (!cur) { bestByOvr.set(key, s); continue; }
    const sActive = s.state !== 'closed';
    const curActive = cur.state !== 'closed';
    if (sActive !== curActive) {
      if (sActive) bestByOvr.set(key, s);
      continue;
    }
    if (s.startedAt > cur.startedAt) bestByOvr.set(key, s);
  }
  return [...bestByOvr.values()];
}

/** A room's sessions in desk order: the user's drag order (`storedOrder`, from
 *  useRoomOrder) first, then the rest oldest-first. One entry per lineage. */
export function sortRoomSessions(sessions: Session[], storedOrder: string[]): Session[] {
  const all = dedupByOverlord(sessions);
  if (storedOrder.length === 0) return all.sort(byStartedAt);
  const orderedMap = new Map(storedOrder.map((id, idx) => [id, idx]));
  const inOrder = all
    .filter(s => orderedMap.has(orderKey(s)))
    .sort((a, b) => (orderedMap.get(orderKey(a)) ?? 0) - (orderedMap.get(orderKey(b)) ?? 0));
  const notInOrder = all
    .filter(s => !orderedMap.has(orderKey(s)))
    .sort(byStartedAt);
  return [...inOrder, ...notInOrder];
}
