import { useState, useCallback } from 'react';

const STORAGE_KEY = 'overlord:roomOrder';

type RoomOrderMap = Record<string, string[]>;

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

export function useRoomOrder() {
  const [orderMap, setOrderMap] = useState<RoomOrderMap>(readStorage);

  const getOrder = useCallback(
    (roomSlug: string): string[] => orderMap[roomSlug] ?? [],
    [orderMap],
  );

  const setOrder = useCallback((roomSlug: string, sessionIds: string[]) => {
    setOrderMap((prev) => {
      const next = { ...prev, [roomSlug]: sessionIds };
      writeStorage(next);
      return next;
    });
  }, []);

  return { getOrder, setOrder };
}
