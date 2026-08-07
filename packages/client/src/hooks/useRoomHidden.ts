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
 * Module-level store rather than per-component state: navigation code outside
 * the Room tree (worker scroll, search) has to be able to unhide a room, and
 * every mounted component must see that immediately.
 */
let hiddenMap: RoomHiddenMap = readStorage();
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

export function hideRoom(roomId: string): void {
  if (hiddenMap[roomId]) return;
  commit({ ...hiddenMap, [roomId]: true });
}

/** No-op when the room is already visible, so callers can fire it blindly. */
export function unhideRoom(roomId: string): void {
  if (!hiddenMap[roomId]) return;
  const next = { ...hiddenMap };
  delete next[roomId];
  commit(next);
}

export function unhideAll(): void {
  if (Object.keys(hiddenMap).length === 0) return;
  commit({});
}

export function useRoomHidden() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isHidden = useCallback((roomId: string): boolean => map[roomId] ?? false, [map]);
  return { map, isHidden, hide: hideRoom, unhide: unhideRoom, unhideAll };
}
