import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'overlord:roomFilesOpen';

type RoomFilesOpenMap = Record<string, boolean>;

function readStorage(): RoomFilesOpenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as RoomFilesOpenMap;
  } catch {
    return {};
  }
}

function writeStorage(map: RoomFilesOpenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / blocked storage
  }
}

/** Same module-level store shape as useRoomCollapsed: one map, every Room subscribes. */
let openMap: RoomFilesOpenMap = readStorage();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): RoomFilesOpenMap {
  return openMap;
}

export function toggleRoomFilesOpen(roomId: string): void {
  const next = { ...openMap };
  if (next[roomId]) delete next[roomId];
  else next[roomId] = true;
  openMap = next;
  writeStorage(next);
  for (const listener of listeners) listener();
}

export function useRoomFilesOpen() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isFilesOpen = useCallback((roomId: string): boolean => map[roomId] ?? false, [map]);
  return { isFilesOpen, toggleFiles: toggleRoomFilesOpen };
}
