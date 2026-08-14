import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'overlord:roomHidden';

type RoomHiddenMap = Record<string, boolean>;

function readStorage(): RoomHiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as RoomHiddenMap;
  } catch {
    return {};
  }
}

function writeStorage(map: RoomHiddenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

/**
 * Durable copy lives in the server's room config. Fire-and-forget: an old
 * server without `hidden` support just ignores the field or 404s — localStorage
 * keeps the feature working either way.
 */
function syncToServer(cwd: string, hidden: boolean): void {
  try {
    void fetch('/api/room-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, hidden }),
    }).catch(() => { /* best-effort */ });
  } catch {
    // no fetch in test envs
  }
}

/**
 * Module-level store rather than per-component state: navigation code outside
 * the Room tree (worker scroll, search) has to be able to unhide a room, and
 * every mounted component must see that immediately.
 */
let hiddenMap: RoomHiddenMap = readStorage();
/** Room ids already seeded from a server snapshot. Per-room, not a global
 *  one-shot flag: the first snapshot after a server restart is often partial
 *  (hydration still running), so rooms that surface a few ticks later must
 *  still get their persisted `hidden` applied. */
const seededRooms = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable reference between writes — required by useSyncExternalStore. */
function getSnapshot(): RoomHiddenMap {
  return hiddenMap;
}

function commit(next: RoomHiddenMap): void {
  hiddenMap = next;
  writeStorage(next);
  emit();
}

export function isRoomHidden(roomId: string): boolean {
  return hiddenMap[roomId] ?? false;
}

export function hideRoom(roomId: string, cwd?: string): void {
  if (cwd) syncToServer(cwd, true);
  if (hiddenMap[roomId]) return;
  commit({ ...hiddenMap, [roomId]: true });
}

/** No-op when the room is already visible, so callers can fire it blindly. */
export function unhideRoom(roomId: string, cwd?: string): void {
  if (!hiddenMap[roomId]) return;
  if (cwd) syncToServer(cwd, false);
  const next = { ...hiddenMap };
  delete next[roomId];
  commit(next);
}

export function unhideAll(rooms?: ReadonlyArray<{ id: string; cwd: string }>): void {
  if (rooms) {
    for (const room of rooms) {
      if (hiddenMap[room.id]) syncToServer(room.cwd, false);
    }
  }
  if (Object.keys(hiddenMap).length === 0) return;
  commit({});
}

/**
 * Union-merge server-persisted hidden rooms into the local store, once per
 * room per page load. Server only adds the first time a room is seen — after
 * that the local store is authoritative and syncs back via syncToServer, so a
 * locally-unhidden room never gets re-hidden by a later snapshot.
 */
export function seedFromServer(rooms: ReadonlyArray<{ id: string; hidden?: boolean }>): void {
  const additions = rooms.filter(r => !seededRooms.has(r.id) && r.hidden === true && !hiddenMap[r.id]);
  for (const room of rooms) seededRooms.add(room.id);
  if (additions.length === 0) return;
  const next = { ...hiddenMap };
  for (const room of additions) next[room.id] = true;
  commit(next);
}

export function useRoomHidden() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isHidden = useCallback((roomId: string): boolean => map[roomId] ?? false, [map]);
  return { map, isHidden, hide: hideRoom, unhide: unhideRoom, unhideAll };
}
