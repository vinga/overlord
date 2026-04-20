import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY_AUTO = 'overlord:autoNames';
const LEGACY_CUSTOM_KEY = 'overlord:customNames';
const MIGRATION_DONE_KEY = 'overlord:customNames:migrated';

function loadAuto(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_AUTO) ?? '{}');
  } catch {
    return {};
  }
}

function saveAuto(names: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY_AUTO, JSON.stringify(names));
}

export function useCustomNames() {
  const [autoNames, setAutoNames] = useState<Record<string, string>>(loadAuto);

  const rename = useCallback((sessionId: string, name: string) => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(() => window.dispatchEvent(new CustomEvent('archive:changed', { detail: {} })))
      .catch(err => console.error('rename failed', err));
  }, []);

  // One-shot migration: upload legacy localStorage renames to the server, then
  // clear the key so future sessions can't drift.
  useEffect(() => {
    if (localStorage.getItem(MIGRATION_DONE_KEY)) return;
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_CUSTOM_KEY) ?? '{}') as Record<string, string>;
      const entries = Object.entries(legacy).filter(([id, name]) => id && typeof name === 'string' && name.trim());
      if (entries.length === 0) {
        localStorage.setItem(MIGRATION_DONE_KEY, '1');
        localStorage.removeItem(LEGACY_CUSTOM_KEY);
        return;
      }
      Promise.allSettled(entries.map(([sid, name]) =>
        fetch(`/api/sessions/${encodeURIComponent(sid)}/name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      )).finally(() => {
        localStorage.setItem(MIGRATION_DONE_KEY, '1');
        localStorage.removeItem(LEGACY_CUSTOM_KEY);
      });
    } catch {
      localStorage.setItem(MIGRATION_DONE_KEY, '1');
    }
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

  const migrateSession = useCallback((oldId: string, newId: string) => {
    setAutoNames(prev => {
      if (!prev[oldId]) return prev;
      const next = { ...prev, [newId]: prev[oldId] };
      delete next[oldId];
      saveAuto(next);
      return next;
    });
  }, []);

  return { autoNames, rename, ensureAutoName, migrateSession };
}
