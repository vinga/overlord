/** Session groups (tags) in the side room list — shared by the list and the session menu. */

export function putGroup(sessionId: string, group: string | null): Promise<Response> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/group`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group }),
  });
}

/** Group names in a room, in order of their first session. */
export function groupNames(sessions: ReadonlyArray<{ group?: string }>): string[] {
  const seen = new Set<string>();
  for (const s of sessions) if (s.group) seen.add(s.group);
  return [...seen];
}

/** Desk rows in the room view: ungrouped sessions first (always present, `group` null),
 *  then one section per group in order of its first session. Order inside a section
 *  follows `sessions`. Without groups the single section reuses the input array. */
export function splitDeskSections<T extends { group?: string }>(sessions: T[]): { group: string | null; sessions: T[] }[] {
  if (!sessions.some(s => s.group)) return [{ group: null, sessions }];
  const loose: T[] = [];
  const groups = new Map<string, T[]>();
  for (const s of sessions) {
    if (!s.group) { loose.push(s); continue; }
    const g = groups.get(s.group);
    if (g) g.push(s); else groups.set(s.group, [s]);
  }
  return [{ group: null, sessions: loose }, ...[...groups].map(([group, list]) => ({ group, sessions: list }))];
}

/** Folded groups, keyed `roomId\u0001group`; per browser. */
export const GROUPS_COLLAPSED_KEY = 'overlord:roomTabsGroupsCollapsed';
/** Fired on `window` after the folded-groups set changes outside the side list. */
export const GROUPS_COLLAPSED_EVENT = 'overlord:groups-collapsed';
export const groupKey = (roomId: string, group: string) => `${roomId}\u0001${group}`;

export function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUPS_COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(set: Set<string>): void {
  try { localStorage.setItem(GROUPS_COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

/** A folded group stays folded under its new name. Returns the same set when nothing moved. */
export function moveCollapsedGroup(prev: Set<string>, roomId: string, from: string, to: string): Set<string> {
  if (!prev.has(groupKey(roomId, from))) return prev;
  const next = new Set(prev);
  next.delete(groupKey(roomId, from));
  next.add(groupKey(roomId, to));
  return next;
}

/** Rename a group: every session filed under `from` moves to `to`. False when there is nothing to do. */
export function renameGroup(
  roomId: string,
  sessions: ReadonlyArray<{ sessionId: string; group?: string }>,
  from: string,
  to: string,
): boolean {
  const name = to.trim();
  if (!name || name === from) return false;
  for (const s of sessions) if (s.group === from) void putGroup(s.sessionId, name);
  const prev = readCollapsedGroups();
  const next = moveCollapsedGroup(prev, roomId, from, name);
  if (next !== prev) {
    writeCollapsedGroups(next);
    window.dispatchEvent(new Event(GROUPS_COLLAPSED_EVENT));
  }
  return true;
}
