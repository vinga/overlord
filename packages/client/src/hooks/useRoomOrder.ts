import { useSyncExternalStore, useCallback } from 'react';

const STORAGE_KEY = 'overlord:roomOrder';

type RoomOrderMap = Record<string, string[]>;

// Shared store — all useRoomOrder() instances see the same state
let currentMap: RoomOrderMap = readStorage();
const listeners = new Set<() => void>();

function readStorage(): RoomOrderMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as RoomOrderMap;
  } catch {
    return {};
  }
}

function writeStorage(map: RoomOrderMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): RoomOrderMap {
  return currentMap;
}

function updateMap(fn: (prev: RoomOrderMap) => RoomOrderMap): void {
  const next = fn(currentMap);
  if (next === currentMap) return;
  currentMap = next;
  writeStorage(next);
  notify();
}

export function useRoomOrder() {
  const orderMap = useSyncExternalStore(subscribe, getSnapshot);

  const getOrder = useCallback(
    (roomSlug: string): string[] => orderMap[roomSlug] ?? [],
    [orderMap],
  );

  const setOrder = useCallback((roomSlug: string, sessionIds: string[]) => {
    updateMap(prev => ({ ...prev, [roomSlug]: sessionIds }));
  }, []);

  // Replace oldId with newId across all room order arrays (called on /clear)
  const migrateSession = useCallback((oldId: string, newId: string) => {
    updateMap(prev => {
      let changed = false;
      const next: RoomOrderMap = {};
      for (const [slug, ids] of Object.entries(prev)) {
        const idx = ids.indexOf(oldId);
        if (idx !== -1) {
          const newIds = [...ids];
          newIds[idx] = newId;
          next[slug] = newIds;
          changed = true;
        } else {
          next[slug] = ids;
        }
      }
      if (!changed) return prev;
      return next;
    });
  }, []);

  return { getOrder, setOrder, migrateSession };
}
