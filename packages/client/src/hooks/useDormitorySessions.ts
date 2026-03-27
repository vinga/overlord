import { useState, useCallback } from 'react';

const STORAGE_KEY = 'overlord:dormitorySessions';

function load(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (arr !== null) return new Set(arr as string[]);
    // Migrate from old pinned sessions
    const pinned = JSON.parse(localStorage.getItem('overlord:pinnedSessions') ?? '[]') as string[];
    return new Set(pinned);
  } catch {
    return new Set();
  }
}

function save(set: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

export function useDormitorySessions() {
  const [dormitorySessions, setDormitorySessions] = useState<Set<string>>(load);

  const toggleDormitory = useCallback((sessionId: string) => {
    setDormitorySessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      save(next);
      return next;
    });
  }, []);

  const isInDormitory = useCallback((sessionId: string) => dormitorySessions.has(sessionId), [dormitorySessions]);

  return { dormitorySessions, toggleDormitory, isInDormitory };
}
