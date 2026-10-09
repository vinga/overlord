import type { DeskSpan } from '../types';

/** Room desk grid: every card covers whole cells of this size. Mirrors the
 *  `.desks` grid template in Room.module.css. */
export const DESK_CELL_W = 250;
export const DESK_CELL_H = 140;
export const DESK_GAP = 14;
export const DESK_SPAN_MAX = { w: 3, h: 4 } as const;

const UNIT: DeskSpan = { w: 1, h: 1 };

/** Pixel size of `n` cells, including the gaps between them. */
export function spanPx(n: number, cell: number, gap = DESK_GAP): number {
  return n * cell + (n - 1) * gap;
}

/** Nearest whole number of cells for a dragged pixel size, clamped to 1…max. */
export function snapSpan(px: number, cell: number, gap: number, max: number): number {
  const n = Math.round((px + gap) / (cell + gap));
  return Math.min(max, Math.max(1, n));
}

/** How many cell columns fit a container of `width` px. */
export function columnsFor(width: number, cell = DESK_CELL_W, gap = DESK_GAP): number {
  return Math.max(1, Math.floor((width + gap) / (cell + gap)));
}

/** Span to render: saved span (or 1×1), width clamped to the room's columns. */
export function effectiveSpan(span: DeskSpan | undefined, columns: number): DeskSpan {
  const s = span ?? UNIT;
  const w = Math.min(s.w, columns);
  return w === s.w ? s : { w, h: s.h };
}
