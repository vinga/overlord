import { useState, useEffect } from 'react';

let current: string | undefined = undefined;
const listeners = new Set<() => void>();

export function setJiraBaseUrl(next: string | undefined): void {
  const normalized = next && next.length > 0 ? next : undefined;
  if (normalized === current) return;
  current = normalized;
  listeners.forEach((l) => l());
}

export function useJiraBaseUrl(): string | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return current;
}
