import { useState, useCallback } from 'react';

const STORAGE_KEY = 'overlord:customNames';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(names: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
}

export function useCustomNames() {
  const [customNames, setCustomNames] = useState<Record<string, string>>(load);

  const rename = useCallback((sessionId: string, name: string) => {
    setCustomNames((prev) => {
      const next = { ...prev };
      if (name.trim()) {
        next[sessionId] = name.trim();
      } else {
        delete next[sessionId];
      }
      save(next);
      return next;
    });
  }, []);

  const getDisplayName = useCallback(
    (session: { sessionId: string; proposedName?: string; slug?: string }) =>
      customNames[session.sessionId] ??
      session.proposedName ??
      session.slug ??
      session.sessionId.slice(0, 8),
    [customNames]
  );

  return { customNames, rename, getDisplayName };
}
