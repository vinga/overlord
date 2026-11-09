import { useEffect, useState } from 'react';

/** One archive request for the navigation and the room header. */
export function useArchiveCounts() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const response = await fetch('/api/archive');
        if (!response.ok) return;
        const data = await response.json() as { entries: { roomId: string }[] };
        const next: Record<string, number> = {};
        for (const entry of data.entries) next[entry.roomId] = (next[entry.roomId] ?? 0) + 1;
        if (!cancelled && current === generation) setCounts(next);
      } catch { /* Retain the last known counts until the next archive change. */ }
    };
    void load();
    window.addEventListener('archive:changed', load);
    return () => { cancelled = true; window.removeEventListener('archive:changed', load); };
  }, []);
  return counts;
}
