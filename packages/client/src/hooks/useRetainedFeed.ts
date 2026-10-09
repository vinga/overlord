import { useEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../types';
import { retainEvicted, RETAINED_FEED_MAX } from '../lib/retainedFeed';

/** Items that slid out of the focused session's snapshot tail, kept client-side so
 *  a live conversation doesn't keep collapsing to "· · ·" as new tool rows arrive.
 *  Zero server cost: the snapshot stays at its ~10-item tail. Only a gap (more new
 *  items in one tick than the tail holds) costs one `activity-before` fetch. */
export function useRetainedFeed(sessionId: string | undefined, feed: ActivityItem[] | undefined): ActivityItem[] {
  const [retained, setRetained] = useState<ActivityItem[]>([]);
  const prevFeedRef = useRef<ActivityItem[] | undefined>(undefined);
  const retainedRef = useRef(retained);
  retainedRef.current = retained;
  // Not aborted per tick: the feed re-ticks at up to 5Hz and would cancel the
  // refill before it lands. Only a session switch aborts it.
  const gapFetchRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRetained([]);
    prevFeedRef.current = undefined;
    return () => { gapFetchRef.current?.abort(); gapFetchRef.current = null; };
  }, [sessionId]);

  useEffect(() => {
    const prev = prevFeedRef.current;
    prevFeedRef.current = feed;
    if (!sessionId || prev === feed) return;
    const { retained: next, gap } = retainEvicted(prev, feed, retainedRef.current);
    if (!gap) {
      if (next !== retainedRef.current) setRetained(next);
      return;
    }
    const oldest = feed?.[0]?.timestamp;
    if (!oldest) { setRetained([]); return; }
    if (gapFetchRef.current) return;
    const controller = new AbortController();
    gapFetchRef.current = controller;
    fetch(`/api/sessions/${sessionId}/activity-before?timestamp=${encodeURIComponent(oldest)}&limit=30`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((data: { items?: ActivityItem[] }) => {
        if (controller.signal.aborted) return;
        // Keep anything evicted while the fetch was in flight (it's newer than `oldest`).
        const since = retainedRef.current.filter(it => (it.timestamp ?? '') >= oldest);
        const merged = [...(data.items ?? []), ...since];
        setRetained(merged.length > RETAINED_FEED_MAX ? merged.slice(merged.length - RETAINED_FEED_MAX) : merged);
      })
      .catch(() => { /* aborted or offline — keep what we have */ })
      .finally(() => { if (gapFetchRef.current === controller) gapFetchRef.current = null; });
  }, [sessionId, feed]);

  return retained;
}
