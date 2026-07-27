import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'overlord:roomCollapsed';

type RoomCollapsedMap = Record<string, boolean>;

function readStorage(): RoomCollapsedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as RoomCollapsedMap;
  } catch {
    return {};
  }
}

function writeStorage(map: RoomCollapsedMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

/**
 * Module-level store rather than per-component state: navigation code outside
 * the Room tree (worker scroll, breadcrumbs) has to be able to expand a room,
 * and every mounted Room must see that immediately. A `useState` copy per Room
 * cannot be reached from the outside.
 */
let collapsedMap: RoomCollapsedMap = readStorage();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable reference between writes — required by useSyncExternalStore. */
function getSnapshot(): RoomCollapsedMap {
  return collapsedMap;
}

function commit(next: RoomCollapsedMap): void {
  collapsedMap = next;
  writeStorage(next);
  emit();
}

export function isRoomCollapsed(roomId: string): boolean {
  return collapsedMap[roomId] ?? false;
}

export function toggleRoomCollapsed(roomId: string): void {
  commit({ ...collapsedMap, [roomId]: !collapsedMap[roomId] });
}

/** No-op when the room is already expanded, so callers can fire it blindly. */
export function expandRoom(roomId: string): void {
  if (!collapsedMap[roomId]) return;
  const next = { ...collapsedMap };
  delete next[roomId];
  commit(next);
}

export function useRoomCollapsed() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isCollapsed = useCallback((roomId: string): boolean => map[roomId] ?? false, [map]);
  return { isCollapsed, toggle: toggleRoomCollapsed, expand: expandRoom };
}
