import { useState, useCallback } from 'react';

const STORAGE_KEY = 'overlord:customNames';
const STORAGE_KEY_AUTO = 'overlord:autoNames';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function loadAuto(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_AUTO) ?? '{}');
  } catch {
    return {};
  }
}

function save(names: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
}

function saveAuto(names: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY_AUTO, JSON.stringify(names));
}

export function useCustomNames() {
  const [customNames, setCustomNames] = useState<Record<string, string>>(load);
  const [autoNames, setAutoNames] = useState<Record<string, string>>(loadAuto);

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

  const ensureAutoName = useCallback((session: { sessionId: string; sessionType?: string }) => {
    setAutoNames(prev => {
      if (prev[session.sessionId]) return prev;
      const type = session.sessionType === 'embedded' ? 'Terminal Session' : 'Overlord Session';
      const count = Object.values(prev).filter(n => n.startsWith(type)).length + 1;
      const next = { ...prev, [session.sessionId]: `${type} ${count}` };
      saveAuto(next);
      return next;
    });
  }, []);

  const getDisplayName = useCallback(
    (session: { sessionId: string; proposedName?: string; slug?: string }) =>
      customNames[session.sessionId] ??
      session.proposedName ??
      autoNames[session.sessionId] ??
      session.slug ??
      session.sessionId.slice(0, 8),
    [customNames, autoNames]
  );

  return { customNames, autoNames, rename, getDisplayName, ensureAutoName };
}
