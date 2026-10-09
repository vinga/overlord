import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeskSpan, Session } from '../types';
import { putDeskSpan } from '../lib/sessionAppearance';
import {
  DESK_CELL_H, DESK_CELL_W, DESK_GAP, DESK_SPAN_MAX,
  columnsFor, effectiveSpan, snapSpan, spanPx,
} from '../lib/deskGrid';

/** Optimistic span shown until the snapshot echoes it back (or this expires). */
const OVERRIDE_TTL_MS = 5000;

interface Drag {
  sessionId: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  span: DeskSpan;
}

/**
 * Corner-grip resizing for room desk cards. Cards snap to whole grid cells:
 * while dragging, `ghost` is the span the card will take; on release it's
 * saved via PUT /api/sessions/:id/desk-span and shown optimistically.
 */
export function useDeskResize() {
  // Callback ref: the grid unmounts while the room is collapsed.
  const [desksEl, desksRef] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState<number>(DESK_SPAN_MAX.w);
  const [ghost, setGhost] = useState<{ sessionId: string; span: DeskSpan } | null>(null);
  // `span: null` = user reset to auto-size, pending the snapshot echo.
  const [overrides, setOverrides] = useState<Record<string, { span: DeskSpan | null; at: number }>>({});
  // Natural content height per desk (px), measured from the worker inside it.
  // Un-resized cards size themselves to the cells this needs.
  const [needPx, setNeedPx] = useState<Record<string, number>>({});
  const dragRef = useRef<Drag | null>(null);
  const measureRO = useRef<ResizeObserver | null>(null);
  const bodyRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const observed = useRef(new Set<HTMLElement>());
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Column count follows the room's width, so wide cards clamp instead of overflowing.
  useEffect(() => {
    const el = desksEl;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setColumns(columnsFor(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [desksEl]);

  // Created lazily: child callback refs attach before this hook's effects run.
  const getMeasureRO = useCallback((): ResizeObserver => {
    if (measureRO.current) return measureRO.current;
    measureRO.current = new ResizeObserver(entries => {
      const updates: Record<string, number> = {};
      for (const entry of entries) {
        const content = entry.target as HTMLElement;
        const body = content.parentElement;
        const desk = content.closest('[data-desk-sid]') as HTMLElement | null;
        if (!body || !desk) continue;
        // Card chrome (padding, footer, gaps) is whatever isn't the body.
        const chrome = desk.offsetHeight - body.clientHeight;
        updates[desk.dataset.deskSid!] = Math.ceil(content.offsetHeight + chrome);
      }
      setNeedPx(prev => {
        let changed = false;
        for (const [k, v] of Object.entries(updates)) if (prev[k] !== v) { changed = true; break; }
        return changed ? { ...prev, ...updates } : prev;
      });
    });
    return measureRO.current;
  }, []);

  // Re-observe on (re)mount — StrictMode runs cleanup + setup without
  // re-attaching refs.
  useEffect(() => {
    const ro = getMeasureRO();
    for (const el of observed.current) ro.observe(el);
    return () => { ro.disconnect(); measureRO.current = null; };
  }, [getMeasureRO]);

  /** Callback ref for the element wrapping a desk's worker content. Cached per
   *  session so React doesn't detach/re-attach it every render. */
  const bodyRef = useCallback((sessionId: string) => {
    let ref = bodyRefs.current.get(sessionId);
    if (!ref) {
      let current: HTMLElement | null = null;
      ref = (el: HTMLElement | null) => {
        if (current) { getMeasureRO().unobserve(current); observed.current.delete(current); }
        current = el;
        if (el) { getMeasureRO().observe(el); observed.current.add(el); }
      };
      bodyRefs.current.set(sessionId, ref);
    }
    return ref;
  }, [getMeasureRO]);

  /** Rows a card's content needs at its natural height (1…max). */
  const autoRows = useCallback((sessionId: string): number => {
    const px = needPx[sessionId];
    return px ? Math.min(DESK_SPAN_MAX.h, Math.max(1, Math.ceil((px + DESK_GAP) / (DESK_CELL_H + DESK_GAP)))) : 1;
  }, [needPx]);

  const spanOf = useCallback((session: Session): DeskSpan => {
    const o = overrides[session.sessionId];
    const saved = o && Date.now() - o.at < OVERRIDE_TTL_MS ? o.span : session.deskSpan ?? null;
    if (saved) return effectiveSpan(saved, columns);
    const h = autoRows(session.sessionId);
    return h === 1 ? effectiveSpan(undefined, columns) : { w: 1, h };
  }, [overrides, columns, autoRows]);

  /** True when the card's content is taller than its span — show the fade. */
  const isClipped = useCallback((sessionId: string, span: DeskSpan): boolean => {
    const px = needPx[sessionId];
    return px != null && px > spanPx(span.h, DESK_CELL_H) + 1;
  }, [needPx]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const w = snapSpan(d.startW + e.clientX - d.startX, DESK_CELL_W, DESK_GAP, Math.min(DESK_SPAN_MAX.w, columnsRef.current));
    const h = snapSpan(d.startH + e.clientY - d.startY, DESK_CELL_H, DESK_GAP, DESK_SPAN_MAX.h);
    if (w !== d.span.w || h !== d.span.h) {
      d.span = { w, h };
      setGhost({ sessionId: d.sessionId, span: d.span });
    }
  }, []);

  const commit = useCallback((sessionId: string, span: DeskSpan | null) => {
    setOverrides(prev => ({ ...prev, [sessionId]: { span, at: Date.now() } }));
    putDeskSpan(sessionId, span);
  }, []);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setGhost(null);
    if (d) commit(d.sessionId, d.span);
  }, [onPointerMove, commit]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  /** Props for the corner grip of `session`'s desk. */
  const gripProps = useCallback((session: Session) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const desk = e.currentTarget.closest('[data-desk-sid]') as HTMLElement | null;
      if (!desk) return;
      const rect = desk.getBoundingClientRect();
      const span = spanOf(session);
      dragRef.current = {
        sessionId: session.sessionId,
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height,
        span,
      };
      setGhost({ sessionId: session.sessionId, span });
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    // Keep the desk's HTML5 drag-reorder and click-to-select out of it.
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      commit(session.sessionId, null);
    },
  }), [spanOf, onPointerMove, onPointerUp, commit]);

  return { desksRef, bodyRef, spanOf, isClipped, gripProps, ghost, resizing: ghost != null };
}
