import { useState, useCallback } from 'react';

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

export function useRoomCollapsed() {
  const [collapsedMap, setCollapsedMap] = useState<RoomCollapsedMap>(readStorage);

  const isCollapsed = useCallback(
    (roomId: string): boolean => collapsedMap[roomId] ?? false,
    [collapsedMap],
  );

  const toggle = useCallback((roomId: string) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [roomId]: !prev[roomId] };
      writeStorage(next);
      return next;
    });
  }, []);

  return { isCollapsed, toggle };
}
