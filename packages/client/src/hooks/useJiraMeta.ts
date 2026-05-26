import { useState, useEffect } from 'react';
import type { JiraIssueMeta } from '../types';

let current: Record<string, JiraIssueMeta> = {};
const listeners = new Set<() => void>();

function sameMeta(a: JiraIssueMeta, b: JiraIssueMeta): boolean {
  return a.title === b.title && a.type === b.type
    && a.status === b.status && a.statusCategory === b.statusCategory;
}

export function setJiraMeta(next: Record<string, JiraIssueMeta> | undefined): void {
  const normalized = next ?? {};
  // Shallow compare — snapshot ticks 3-4x/s; skip rerenders when unchanged.
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

export function useJiraMeta(): Record<string, JiraIssueMeta> {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return current;
}

export function getJiraMetaSnapshot(): Record<string, JiraIssueMeta> {
  return current;
}
