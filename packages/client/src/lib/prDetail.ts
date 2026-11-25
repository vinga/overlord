import { useEffect, useState } from 'react';
import type { PrDetail } from '../types';

// Client side of `GET /api/pr-detail`: a short cache shared by the hover card
// and the waiting-on line on PR cards, so both cost one request.

const CLIENT_TTL_MS = 30_000;
/** How often an open PR card on screen refreshes its waiting-on line. */
export const PR_REFRESH_MS = 60_000;

export type PrLoaded = { detail: PrDetail } | { error: string };

const cache = new Map<string, { at: number; value: PrLoaded }>();
const inflight = new Map<string, Promise<PrLoaded>>();

export function loadPrDetail(ref: string): Promise<PrLoaded> {
  const hit = cache.get(ref);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return Promise.resolve(hit.value);
  const running = inflight.get(ref);
  if (running) return running;
  const p = (async (): Promise<PrLoaded> => {
    try {
      const res = await fetch(`/api/pr-detail?ref=${encodeURIComponent(ref)}`);
      if (res.ok) return { detail: await res.json() as PrDetail };
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { error: body.error ?? `HTTP ${res.status}` };
    } catch {
      return { error: 'network' };
    }
  })().then((value) => {
    if ('detail' in value) cache.set(ref, { at: Date.now(), value });
    return value;
  }).finally(() => inflight.delete(ref));
  inflight.set(ref, p);
  return p;
}

/** Detail for `ref` while `enabled`, refreshed every PR_REFRESH_MS. */
export function usePrDetail(ref: string | undefined, enabled: boolean): PrDetail | undefined {
  const [detail, setDetail] = useState<PrDetail | undefined>(() => {
    const hit = ref ? cache.get(ref)?.value : undefined;
    return hit && 'detail' in hit ? hit.detail : undefined;
  });
  useEffect(() => {
    if (!ref || !enabled) return;
    let alive = true;
    const run = () => { void loadPrDetail(ref).then((v) => { if (alive && 'detail' in v) setDetail(v.detail); }); };
    run();
    const t = window.setInterval(() => { if (document.visibilityState !== 'hidden') run(); }, PR_REFRESH_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [ref, enabled]);
  return detail;
}
