import { useSyncExternalStore, useCallback } from 'react';

const STORAGE_KEY = 'overlord:roomsListOrder';

// Ordered list of room IDs
let currentOrder: string[] = readStorage();
const listeners = new Set<() => void>();

function readStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function writeStorage(order: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
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

function getSnapshot(): string[] {
  return currentOrder;
}

function setCurrentOrder(next: string[]): void {
  if (next === currentOrder) return;
  currentOrder = next;
  writeStorage(next);
  notify();
}

export function useRoomsListOrder() {
  const order = useSyncExternalStore(subscribe, getSnapshot);

  /**
   * Sort rooms by persisted order. Unknown rooms go to the end.
   * Call this inside useMemo — it is side-effect-free.
   */
  const sortRooms = useCallback(
    <T extends { id: string }>(rooms: T[]): T[] => {
      return [...rooms].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        // Unknown rooms (index -1) go to the end
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    },
    [order],
  );

  /**
   * Register room IDs that have never been seen before.
   * Call this from a useEffect so it doesn't run during render.
   */
  const registerRooms = useCallback((roomIds: string[]) => {
    const knownIds = new Set(currentOrder);
    const newIds = roomIds.filter(id => !knownIds.has(id));
    if (newIds.length > 0) {
      setCurrentOrder([...currentOrder, ...newIds]);
    }
  }, []);

  /**
   * Move draggedId to immediately before targetId.
   */
  const moveRoom = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const prev = currentOrder;
    const next = prev.filter(id => id !== draggedId);
    const targetIdx = next.indexOf(targetId);
    if (targetIdx === -1) return;
    next.splice(targetIdx, 0, draggedId);
    setCurrentOrder(next);
  }, []);

  return { sortRooms, registerRooms, moveRoom };
}