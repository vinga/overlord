import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

// Shared controller for the detail cards that open from a chip's peek icon
// (Jira tickets, PRs). Chips inside `container` carry `[keyAttr]=<key>` and hold a
// `[peekAttr]` icon: hovering the icon opens the card, clicking keeps it open.
// The rest of the chip keeps its own click / double-click and only keeps an
// already-open card alive.

const HOVER_DELAY_MS = 180;
const HIDE_DELAY_MS = 200;
/** A card unmounted with its panel comes back on remount when it was kept open,
 *  or was open moments ago. */
const RESTORE_WINDOW_MS = 2000;

export const CARD_GAP = 10;

export interface PeekShown<L> {
  anchor: HTMLElement;
  key: string;
  pinned: boolean;
  loaded: L | null;
}

const persisted = new Map<string, { key: string; pinned: boolean; at: number }>();

function findAnchor(container: HTMLElement | null, keyAttr: string, key: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[${keyAttr}="${CSS.escape(key)}"]`) ?? null;
}

interface Options<L> {
  container: HTMLElement | null;
  keyAttr: string;
  peekAttr: string;
  load: (key: string) => Promise<L>;
}

export function usePeekCard<L>({ container, keyAttr, peekAttr, load }: Options<L>) {
  const [shown, setShown] = useState<PeekShown<L> | null>(null);
  const shownRef = useRef<PeekShown<L> | null>(null);
  shownRef.current = shown;
  const cardRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const keySel = `[${keyAttr}]`;
  const peekSel = `[${peekAttr}]`;

  const clearHide = () => { if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; } };
  const clearShow = () => { if (showTimer.current) { window.clearTimeout(showTimer.current); showTimer.current = null; } };

  const show = useCallback((anchor: HTMLElement, pinned = false) => {
    const key = anchor.getAttribute(keyAttr);
    if (!key) return;
    setShown({ anchor, key, pinned, loaded: null });
    void loadRef.current(key).then((loaded) => {
      setShown((s) => (s && s.key === key ? { ...s, loaded } : s));
    });
  }, [keyAttr]);

  /** Closed on purpose (not unmounted): forget it, so a remount won't restore it. */
  const close = useCallback(() => { persisted.delete(keyAttr); setShown(null); }, [keyAttr]);

  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      if (!shownRef.current?.pinned) close();
    }, HIDE_DELAY_MS);
  }, [close]);

  // Survive a remount: the panel around the chips re-renders on snapshot ticks.
  useEffect(() => () => {
    const cur = shownRef.current;
    if (cur) persisted.set(keyAttr, { key: cur.key, pinned: cur.pinned, at: Date.now() });
  }, [keyAttr]);
  useEffect(() => {
    const p = persisted.get(keyAttr);
    if (!container || !p || shownRef.current) return;
    if (!p.pinned && Date.now() - p.at > RESTORE_WINDOW_MS) return;
    const anchor = findAnchor(container, keyAttr, p.key);
    if (anchor) show(anchor, p.pinned);
  }, [container, keyAttr, show]);

  useEffect(() => {
    if (!container) return;
    const closest = (t: EventTarget | null, sel: string) =>
      (t as HTMLElement | null)?.closest?.(sel) as HTMLElement | null;
    const over = (e: MouseEvent) => {
      const anchor = closest(e.target, keySel);
      if (!anchor) return;
      const cur = shownRef.current;
      if (cur?.anchor === anchor) clearHide();
      if (!closest(e.target, peekSel)) return;
      if (cur?.anchor === anchor || cur?.pinned) return;
      clearShow();
      showTimer.current = window.setTimeout(() => show(anchor), HOVER_DELAY_MS);
    };
    const out = (e: MouseEvent) => {
      const into = e.relatedTarget as Node | null;
      const peek = closest(e.target, peekSel);
      if (peek && !(into && peek.contains(into))) clearShow();
      const anchor = closest(e.target, keySel);
      if (!anchor || (into && anchor.contains(into))) return;
      if (into && cardRef.current?.contains(into)) return;
      const cur = shownRef.current;
      if (cur && cur.anchor === anchor && !cur.pinned) scheduleHide();
    };
    // Click on the peek icon: open and keep open, without following the chip's link.
    const click = (e: MouseEvent) => {
      const peek = closest(e.target, peekSel);
      const anchor = peek && closest(peek, keySel);
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      clearShow();
      const cur = shownRef.current;
      if (cur?.anchor === anchor) setShown({ ...cur, pinned: !cur.pinned });
      else show(anchor, true);
    };
    const swallow = (e: MouseEvent) => {
      if (closest(e.target, peekSel)) { e.preventDefault(); e.stopPropagation(); }
    };
    container.addEventListener('mouseover', over);
    container.addEventListener('mouseout', out);
    container.addEventListener('click', click);
    container.addEventListener('dblclick', swallow);
    return () => {
      clearShow();
      clearHide();
      container.removeEventListener('mouseover', over);
      container.removeEventListener('mouseout', out);
      container.removeEventListener('click', click);
      container.removeEventListener('dblclick', swallow);
    };
  }, [container, show, scheduleHide, keySel, peekSel]);

  // Dismiss: Esc, click outside, a scroll that moves the chip (unpinned only).
  const open = !!shown;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || shownRef.current?.anchor.contains(t)) return;
      close();
    };
    // The conversation auto-scrolling on new output must not close the card.
    const scroll = (e: Event) => {
      const cur = shownRef.current;
      if (!cur || cur.pinned) return;
      const t = e.target as Node | null;
      if (!t || cardRef.current?.contains(t)) return;
      if (t === document || t.contains(cur.anchor)) close();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', down);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', down);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, close]);

  // Chip re-rendered → follow its new element; chip gone (another session) → close.
  const anchor = shown ? (shown.anchor.isConnected ? shown.anchor : findAnchor(container, keyAttr, shown.key)) : null;
  useEffect(() => {
    if (!shown || shown.anchor.isConnected) return;
    if (anchor) setShown({ ...shown, anchor });
    else close();
  });

  const current = shown && anchor ? (anchor === shown.anchor ? shown : { ...shown, anchor }) : null;
  return {
    shown: current,
    cardRef,
    close,
    setPinned: (pinned: boolean) => setShown((s) => (s ? { ...s, pinned } : s)),
    onEnter: clearHide,
    onLeave: (e: React.MouseEvent) => {
      const into = e.relatedTarget as Node | null;
      if (current && into instanceof Node && current.anchor.contains(into)) return;
      if (!current?.pinned) scheduleHide();
    },
  };
}

/** Beside the context column (left of it; right when there is no room),
 *  top-aligned with the chip. */
export function cardPosition(anchor: HTMLElement, container: HTMLElement | null, width: number, maxHeight: number): React.CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const box = (container ?? anchor).getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = box.left - width - CARD_GAP;
  if (left < 8) left = box.right + CARD_GAP;
  if (left + width > vw - 8) left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const top = Math.max(8, rect.top - 6);
  const room = vh - top - 8;
  return room >= 320
    ? { top, left, width, maxHeight: Math.min(room, maxHeight) }
    : { bottom: Math.max(8, vh - rect.bottom - 6), left, width, maxHeight: Math.min(vh - 16, maxHeight) };
}
