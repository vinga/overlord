import { describe, it, expect } from 'vitest';
import { snapSpan, spanPx, columnsFor, effectiveSpan, DESK_CELL_W, DESK_CELL_H, DESK_GAP } from '../deskGrid';

describe('snapSpan', () => {
  const W = DESK_CELL_W;
  const G = DESK_GAP;

  it('returns the exact span for exact pixel sizes', () => {
    expect(snapSpan(spanPx(1, W), W, G, 3)).toBe(1);
    expect(snapSpan(spanPx(2, W), W, G, 3)).toBe(2);
    expect(snapSpan(spanPx(3, W), W, G, 3)).toBe(3);
  });

  it('snaps at the half-cell boundary', () => {
    const half = (W + G) / 2;
    expect(snapSpan(spanPx(1, W) + half - 1, W, G, 3)).toBe(1);
    expect(snapSpan(spanPx(1, W) + half + 1, W, G, 3)).toBe(2);
  });

  it('clamps to 1…max', () => {
    expect(snapSpan(0, W, G, 3)).toBe(1);
    expect(snapSpan(-500, W, G, 3)).toBe(1);
    expect(snapSpan(5000, W, G, 3)).toBe(3);
    expect(snapSpan(5000, DESK_CELL_H, G, 4)).toBe(4);
  });
});

describe('columnsFor', () => {
  it('counts whole cells including gaps, never below 1', () => {
    expect(columnsFor(spanPx(2, DESK_CELL_W))).toBe(2);
    expect(columnsFor(spanPx(2, DESK_CELL_W) - 1)).toBe(1);
    expect(columnsFor(50)).toBe(1);
  });
});

describe('effectiveSpan', () => {
  it('defaults to 1×1 and keeps the reference when no clamp applies', () => {
    expect(effectiveSpan(undefined, 3)).toEqual({ w: 1, h: 1 });
    const s = { w: 2, h: 3 };
    expect(effectiveSpan(s, 3)).toBe(s);
  });

  it('clamps width to the available columns, keeps height', () => {
    expect(effectiveSpan({ w: 3, h: 2 }, 2)).toEqual({ w: 2, h: 2 });
  });
});
