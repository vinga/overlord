import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks which of *your* messages governs the currently-visible stretch of the
 * transcript, so the Conversation view can pin it as a one-line header.
 *
 * The governing message is the last user bubble whose top has scrolled above
 * the top edge of the scroll container. When none has (short session, or your
 * prompt is still fully on screen) the result is null and no header renders —
 * nothing is duplicated. At the live tail the governing message is your latest
 * prompt, which is the case this exists for: long agent runs bury it under
 * tool calls.
 *
 * Candidates are marked in the DOM by FeedSegments (`data-user-msg` = key,
 * `data-user-text` = display text) rather than re-derived here, so the segment
 * logic stays in one place.
 */

export interface StickyUserMessage {
  key: string;
  text: string;
  /** Whether a later user message exists below the fold — enables the ▼ arrow. */
  hasNext: boolean;
}

/** How far below the top edge a jump parks the target message. */
const LANDING = 8;

interface Args {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Identity tokens that re-run the scan when they change. Pass primitives
   *  (counts, tab names), not the feed arrays themselves — DetailPanel rebuilds
   *  those every WebSocket tick and a re-scan per render is wasted DOM work. */
  feedKey: unknown;
  extraKey?: unknown;
  viewKey?: string;
  enabled: boolean;
}

export function useStickyUserMessage({ containerRef, feedKey, extraKey, viewKey, enabled }: Args) {
  const [sticky, setSticky] = useState<StickyUserMessage | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirror of `sticky.key` readable from inside the rAF without re-creating the
  // callback on every change (the scroll handler holds a stable reference).
  const currentKeyRef = useRef<string | null>(null);
  const indexRef = useRef(-1);
  const nextIdxRef = useRef(-1);
  const hasNextRef = useRef(false);

  const scan = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLElement>('[data-user-msg]');
    if (nodes.length === 0) {
      indexRef.current = -1;
      nextIdxRef.current = -1;
      hasNextRef.current = false;
      if (currentKeyRef.current !== null) {
        currentKeyRef.current = null;
        setSticky(null);
      }
      return;
    }
    const top = container.getBoundingClientRect().top;
    let found: HTMLElement | null = null;
    let foundIdx = -1;
    // Walking backwards visits every message below the fold before the governing
    // one, so the "next" target falls out of the same pass. Anything within
    // LANDING px of the top edge is where a jump just parked us — skipping it is
    // what makes repeated presses advance instead of re-scrolling in place.
    let nextIdx = -1;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const t = nodes[i].getBoundingClientRect().top;
      // 2px of slack: at the exact boundary sub-pixel scroll positions would
      // otherwise toggle the header on and off on consecutive frames.
      if (t < top - 2) {
        found = nodes[i];
        foundIdx = i;
        break;
      }
      if (t > top + LANDING + 4) nextIdx = i;
    }
    indexRef.current = foundIdx;
    nextIdxRef.current = nextIdx;
    const key = found?.getAttribute('data-user-msg') ?? null;
    // Re-render when the "next" arrow's availability flips, even if the pinned
    // message itself is unchanged.
    const hasNext = nextIdx !== -1;
    if (key === currentKeyRef.current && hasNext === hasNextRef.current) return;
    currentKeyRef.current = key;
    hasNextRef.current = hasNext;
    setSticky(key && found
      ? { key, text: found.getAttribute('data-user-text') ?? '', hasNext }
      : null);
  }, [containerRef]);

  /** Scroll the i-th marked user message to just under the top edge. Landing
   *  below the edge (rather than flush) takes it out of "already scrolled past"
   *  range, so the header advances to the message before it and repeated
   *  presses walk back one message at a time. */
  const scrollToIndex = useCallback((i: number) => {
    const container = containerRef.current;
    if (!container || i < 0) return;
    const el = container.querySelectorAll<HTMLElement>('[data-user-msg]')[i];
    if (!el) return;
    const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = Math.max(0, offset - LANDING);
    if (reduceMotion) container.scrollTop = next;
    else container.scrollTo({ top: next, behavior: 'smooth' });
  }, [containerRef]);

  /** Up: jump to the pinned message itself. Down: to the first one still below. */
  const scrollToPrev = useCallback(() => scrollToIndex(indexRef.current), [scrollToIndex]);
  const scrollToNext = useCallback(() => scrollToIndex(nextIdxRef.current), [scrollToIndex]);

  /** Coalesce scans triggered from scroll/resize into one per frame. */
  const recomputeSticky = useCallback(() => {
    if (!enabled) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      scan();
    });
  }, [enabled, scan]);

  // Drop any pinned header the moment the setting is turned off, and skip all
  // DOM work from then on.
  useEffect(() => {
    if (enabled) return;
    currentKeyRef.current = null;
    setSticky(null);
  }, [enabled]);

  // Feed growth shifts every bubble; re-scan after the paint that applied it.
  useEffect(() => {
    if (!enabled) return;
    recomputeSticky();
  }, [enabled, recomputeSticky, feedKey, extraKey, viewKey]);

  // Lazily-sized content (images, diffs, expanding tool blocks) moves bubbles
  // without a scroll event — without this the header goes stale.
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recomputeSticky());
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, enabled, recomputeSticky]);

  // Clearing the ref matters as much as cancelling: StrictMode's mount/unmount/
  // mount cycle reuses this ref, and a leftover id makes recomputeSticky think a
  // frame is still pending — it would early-return forever.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  return { sticky, recomputeSticky, scrollToPrev, scrollToNext };
}
