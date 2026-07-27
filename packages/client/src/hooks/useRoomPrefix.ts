import { useEffect, useState } from 'react';
import { ROOM_PREFIX_ENABLED } from '../config/featureFlags';

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(l => l());
}

function fetchPrefix(cwd: string): Promise<string> {
  const existing = inFlight.get(cwd);
  if (existing) return existing;
  const p = fetch(`/api/room-config?cwd=${encodeURIComponent(cwd)}`)
    .then(r => r.ok ? r.json() as Promise<{ prefix?: string }> : null)
    .then(cfg => {
      const prefix = cfg?.prefix ?? '';
      cache.set(cwd, prefix);
      notify();
      return prefix;
    })
    .catch(() => {
      cache.set(cwd, '');
      return '';
    })
    .finally(() => { inFlight.delete(cwd); });
  inFlight.set(cwd, p);
  return p;
}

export function useRoomPrefix(cwd: string | undefined): string {
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!ROOM_PREFIX_ENABLED) return;
    const listener = () => rerender(n => n + 1);
    listeners.add(listener);
    if (cwd && !cache.has(cwd)) {
      void fetchPrefix(cwd);
    }
    return () => { listeners.delete(listener); };
  }, [cwd]);

  // Flag off: no request is made and every caller sees an empty prefix.
  if (!ROOM_PREFIX_ENABLED) return '';
  return cwd ? (cache.get(cwd) ?? '') : '';
}

export function selectAfterPrefix(input: HTMLInputElement, prefix: string): void {
  const value = input.value;
  if (prefix && value.startsWith(prefix) && prefix.length < value.length) {
    input.setSelectionRange(prefix.length, value.length);
  } else {
    input.select();
  }
}
