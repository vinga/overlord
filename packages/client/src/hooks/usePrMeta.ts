import { useState, useEffect } from 'react';
import type { PrRefMeta } from '../types';

// Same module-store shape as useJiraMeta: the snapshot ticks 3–4×/s and carries
// prMeta every time, so a plain prop would re-render every chip on every tick.
// The shallow compare below turns "unchanged metadata" into zero renders.
let current: Record<string, PrRefMeta> = {};
const listeners = new Set<() => void>();

function sameMeta(a: PrRefMeta, b: PrRefMeta): boolean {
  return a.title === b.title && a.state === b.state
    && a.isDraft === b.isDraft && a.url === b.url;
}

export function setPrMeta(next: Record<string, PrRefMeta> | undefined): void {
  const normalized = next ?? {};
  const prevKeys = Object.keys(current);
  const nextKeys = Object.keys(normalized);
  if (prevKeys.length === nextKeys.length) {
    let same = true;
    for (const k of nextKeys) {
      const a = current[k];
      const b = normalized[k];
      if (!a || !sameMeta(a, b)) { same = false; break; }
    }
    if (same) return;
  }
  current = normalized;
  listeners.forEach((l) => l());
}

export function usePrMeta(): Record<string, PrRefMeta> {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return current;
}
