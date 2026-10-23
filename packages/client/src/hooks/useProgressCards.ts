import { useEffect, useMemo, useState } from 'react';
import type { BackgroundProgress } from '../types';

/**
 * Progress cards for the chat feed, keyed by the launching Bash toolUseId.
 * Live cards ride the snapshot; persisted ones (closed sessions, after a
 * restart) come from one REST fetch per session. Snapshot wins on overlap.
 */
export function useProgressCards(
  sessionId: string | undefined,
  live: BackgroundProgress[] | undefined,
): Map<string, BackgroundProgress> {
  const [fetched, setFetched] = useState<{ sessionId: string; cards: BackgroundProgress[] } | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/progress`)
      .then(r => (r.ok ? r.json() : { cards: [] }))
      .then((d: { cards: BackgroundProgress[] }) => { if (!cancelled) setFetched({ sessionId, cards: d.cards ?? [] }); })
      .catch(() => { /* cards are an enhancement; the feed renders without them */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  return useMemo(() => {
    const map = new Map<string, BackgroundProgress>();
    if (fetched && fetched.sessionId === sessionId) {
      for (const c of fetched.cards) map.set(c.toolUseId, c);
    }
    for (const c of live ?? []) map.set(c.toolUseId, c);
    return map;
  }, [fetched, sessionId, live]);
}
