import { describe, it, expect } from 'vitest';
import { retainEvicted } from '../retainedFeed';
import type { ActivityItem } from '../../types';

const item = (n: number, extra: Partial<ActivityItem> = {}): ActivityItem => ({
  kind: 'tool', toolName: 'Read', content: `c${n}`,
  timestamp: `2026-10-09T10:00:${String(n).padStart(2, '0')}.000Z`, ...extra,
});
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => item(a + i));
const ids = (xs: ActivityItem[]) => xs.map(x => x.content);

describe('retainEvicted', () => {
  it('keeps items that slid off the front of the tail', () => {
    const r = retainEvicted(range(0, 10), range(3, 13), []);
    expect(r.gap).toBe(false);
    expect(ids(r.retained)).toEqual(['c0', 'c1', 'c2']);
  });

  it('returns the same reference when the tail only grew', () => {
    const retained = [item(99)];
    const r = retainEvicted(range(0, 5), range(0, 7), retained);
    expect(r.retained).toBe(retained);
  });

  it('matches by identity, not content (tool result arrives between ticks)', () => {
    const next = range(2, 12).map(x => ({ ...x, content: x.content + '-done' }));
    expect(ids(retainEvicted(range(0, 10), next, []).retained)).toEqual(['c0', 'c1']);
  });

  it('handles parallel tool calls that share a timestamp', () => {
    const ts = '2026-10-09T10:00:00.000Z';
    const same = (n: number) => item(n, { timestamp: ts });
    const prev = [same(0), same(1), same(2), item(5)];
    const next = [same(2), item(5), item(6)];
    expect(ids(retainEvicted(prev, next, []).retained)).toEqual(['c0', 'c1']);
  });

  it('dedupes when the tail stretches back over retained items', () => {
    const retained = range(0, 5);
    const r = retainEvicted(range(5, 15), range(3, 16), retained);
    expect(r.gap).toBe(false);
    expect(ids(r.retained)).toEqual(['c0', 'c1', 'c2']);
  });

  it('reports a gap when no run is shared', () => {
    const r = retainEvicted(range(0, 10), range(20, 30), [item(99)]);
    expect(r.gap).toBe(true);
  });

  it('caps the retained list in chunks, dropping the oldest', () => {
    const r = retainEvicted(range(0, 10), range(8, 18), range(40, 50), 10);
    // 18 > 10 → trimmed to 10 - 2 = 8, so the next few evictions don't shift indexes.
    expect(ids(r.retained)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  });
});
