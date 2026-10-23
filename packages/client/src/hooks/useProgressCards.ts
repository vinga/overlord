import { useEffect, useMemo, useState } from 'react';
import type { BackgroundProgress, BackgroundTask } from '../types';

/**
 * Progress cards for the chat feed, keyed by the launching Bash toolUseId.
 * Live cards ride the snapshot; persisted ones (closed sessions, after a
 * restart) come from one REST fetch per session. Snapshot wins on overlap.
 */
export function useProgressCards(
  sessionId: string | undefined,
  live: BackgroundProgress[] | undefined,
  /** The session's in-flight background tasks — the transcript's truth on what is running. */
  tasks: BackgroundTask[] | undefined,
): Map<string, BackgroundProgress> {
  const [fetched, setFetched] = useState<{ sessionId: string; cards: BackgroundProgress[] } | null>(null);
  // Refetch whenever a task starts or ends. A card fetched while running would
  // otherwise stay "running" forever once the snapshot stops carrying it.
  const runningKey = (tasks ?? []).map(t => t.toolUseId).sort().join(',');

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/progress`)
      .then(r => (r.ok ? r.json() : { cards: [] }))
      .then((d: { cards: BackgroundProgress[] }) => { if (!cancelled) setFetched({ sessionId, cards: d.cards ?? [] }); })
      .catch(() => { /* cards are an enhancement; the feed renders without them */ });
    return () => { cancelled = true; };
  }, [sessionId, runningKey]);

  return useMemo(() => {
    const map = new Map<string, BackgroundProgress>();
    const runningIds = new Set((tasks ?? []).map(t => t.toolUseId));
    if (fetched && fetched.sessionId === sessionId) {
      for (const c of fetched.cards) {
        // A fetched "running" card whose task is no longer in flight has ended;
        // the refetch keyed on runningKey brings its final state.
        // Push cards have no background task; the snapshot carries their state.
        if (c.status === 'running' && c.source !== 'push' && !runningIds.has(c.toolUseId)) continue;
        map.set(c.toolUseId, c);
      }
    }
    for (const c of live ?? []) map.set(c.toolUseId, c);
    return map;
  }, [fetched, sessionId, live, tasks]);
}
