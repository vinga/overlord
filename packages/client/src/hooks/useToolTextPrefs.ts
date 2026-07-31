import { useSyncExternalStore } from 'react';

const BREAK_KEY = 'overlord.toolText.breakNewlines';
const WRAP_KEY = 'overlord.toolText.wrap';

interface ToolTextPrefs {
  breakNewlines: boolean;
  wrap: boolean;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
  } catch {
    // ignore quota errors
  }
}

/**
 * Module-level store: every expanded args/result block across all ToolEntry
 * instances shows the same pair of toggles, and flipping one must update all
 * of them at once. Per-component useState copies cannot stay in sync.
 */
let prefs: ToolTextPrefs = { breakNewlines: readFlag(BREAK_KEY), wrap: readFlag(WRAP_KEY) };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable reference between writes — required by useSyncExternalStore. */
function getSnapshot(): ToolTextPrefs {
  return prefs;
}

export function toggleBreakNewlines(): void {
  prefs = { ...prefs, breakNewlines: !prefs.breakNewlines };
  writeFlag(BREAK_KEY, prefs.breakNewlines);
  for (const listener of listeners) listener();
}

export function toggleWrap(): void {
  prefs = { ...prefs, wrap: !prefs.wrap };
  writeFlag(WRAP_KEY, prefs.wrap);
  for (const listener of listeners) listener();
}

/**
 * Display-only: turns escaped \n / \t sequences inside the JSON text into real
 * newlines/tabs. Best-effort — a literal backslash-n in a string breaks too.
 */
export function unescapeToolText(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

export function useToolTextPrefs(): ToolTextPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
