import { useState, useCallback } from 'react';

const STORAGE_KEY = 'overlord:pinnedSessions';

function load(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function save(pinned: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(pinned)));
}

export function usePinnedSessions() {
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(load);

  const togglePin = useCallback((sessionId: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      save(next);
      return next;
    });
  }, []);

  return { pinnedSessions, togglePin };
}
