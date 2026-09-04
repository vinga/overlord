import { useCallback, useState } from 'react';

export type QueueRailMode = 'grouped' | 'flat';
export type QueueRailSort = 'oldest' | 'newest';

const KEY_OPEN = 'overlord:queueRail:open';
const KEY_MODE = 'overlord:queueRail:mode';
const KEY_SORT = 'overlord:queueRail:sort';

function read(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export interface QueueRailState {
  open: boolean;
  mode: QueueRailMode;
  sort: QueueRailSort;
  toggleOpen: () => void;
  toggleMode: () => void;
  toggleSort: () => void;
}

/**
 * Persisted rail preferences. Defaults are "manual only": the rail starts
 * collapsed and never opens or closes itself — only the user's click moves it.
 */
export function useQueueRailState(): QueueRailState {
  const [open, setOpen] = useState<boolean>(() => read(KEY_OPEN, '0') === '1');
  const [mode, setMode] = useState<QueueRailMode>(() => (read(KEY_MODE, 'grouped') === 'flat' ? 'flat' : 'grouped'));
  const [sort, setSort] = useState<QueueRailSort>(() => (read(KEY_SORT, 'oldest') === 'newest' ? 'newest' : 'oldest'));

  const toggleOpen = useCallback(() => {
    setOpen(prev => { const next = !prev; write(KEY_OPEN, next ? '1' : '0'); return next; });
  }, []);

  const toggleMode = useCallback(() => {
    setMode(prev => { const next = prev === 'grouped' ? 'flat' : 'grouped'; write(KEY_MODE, next); return next; });
  }, []);

  const toggleSort = useCallback(() => {
    setSort(prev => { const next = prev === 'oldest' ? 'newest' : 'oldest'; write(KEY_SORT, next); return next; });
  }, []);

  return { open, mode, sort, toggleOpen, toggleMode, toggleSort };
}
