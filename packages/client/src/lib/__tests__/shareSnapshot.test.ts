import { describe, expect, it } from 'vitest';
import { shareSnapshot } from '../shareSnapshot';

function makeSnapshot(rooms = 15, perRoom = 6) {
  return {
    updatedAt: '2026-10-05T10:00:00.000Z',
    platform: 'darwin',
    rooms: Array.from({ length: rooms }, (_, r) => ({
      id: `room-${r}`,
      cwd: `/repo/${r}`,
      sessions: Array.from({ length: perRoom }, (_, s) => ({
        sessionId: `s-${r}-${s}`,
        state: 'waiting',
        activityFeed: Array.from({ length: 20 }, (_, i) => ({ kind: 'tool', text: `line ${i}`, durationMs: i })),
        subagents: [{ sessionId: `sub-${r}-${s}`, state: 'closed' }],
      })),
    })),
  };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('shareSnapshot', () => {
  it('returns prev itself when content is identical', () => {
    const prev = makeSnapshot();
    expect(shareSnapshot(prev, clone(prev))).toBe(prev);
  });

  it('gives new refs only along the path of a change', () => {
    const prev = makeSnapshot();
    const next = clone(prev);
    next.rooms[3].sessions[2].state = 'working';
    const out = shareSnapshot(prev, next);

    expect(out).not.toBe(prev);
    expect(out.rooms).not.toBe(prev.rooms);
    expect(out.rooms[3]).not.toBe(prev.rooms[3]);
    expect(out.rooms[3].sessions[2]).not.toBe(prev.rooms[3].sessions[2]);
    expect(out.rooms[3].sessions[2].state).toBe('working');
    // Siblings keep identity.
    expect(out.rooms[2]).toBe(prev.rooms[2]);
    expect(out.rooms[3].sessions[1]).toBe(prev.rooms[3].sessions[1]);
    expect(out.rooms[3].sessions[2].activityFeed).toBe(prev.rooms[3].sessions[2].activityFeed);
    expect(out.platform).toBe('darwin');
  });

  it('handles array length changes', () => {
    const prev = makeSnapshot(2, 2);
    const grown = clone(prev);
    grown.rooms[0].sessions.push(clone(grown.rooms[0].sessions[0]));
    const out = shareSnapshot(prev, grown);
    expect(out.rooms[0].sessions).toHaveLength(3);
    expect(out.rooms[0].sessions[0]).toBe(prev.rooms[0].sessions[0]);
    expect(out.rooms[1]).toBe(prev.rooms[1]);

    const shrunk = clone(prev);
    shrunk.rooms[0].sessions.pop();
    const out2 = shareSnapshot(prev, shrunk);
    expect(out2.rooms[0].sessions).toHaveLength(1);
    expect(out2.rooms[0]).not.toBe(prev.rooms[0]);
  });

  it('handles added and removed keys', () => {
    const prev = { a: 1, b: { c: 2 } } as Record<string, unknown>;
    const added = shareSnapshot(prev, { a: 1, b: { c: 2 }, d: 3 });
    expect(added).not.toBe(prev);
    expect(added.b).toBe(prev.b);
    expect(added.d).toBe(3);

    const removed = shareSnapshot(prev, { b: { c: 2 } });
    expect(removed).not.toBe(prev);
    expect('a' in removed).toBe(false);

    // Same key count, one swapped for an undefined-valued key.
    const swapped = shareSnapshot({ a: undefined } as Record<string, unknown>, { b: undefined });
    expect('b' in swapped).toBe(true);
    expect('a' in swapped).toBe(false);
  });

  it('starts from null', () => {
    const next = makeSnapshot(1, 1);
    expect(shareSnapshot(null as unknown as typeof next, next)).toBe(next);
  });

  it('is fast on a realistic snapshot', () => {
    const prev = makeSnapshot(20, 8);
    const next = clone(prev);
    next.rooms[0].sessions[0].state = 'working';
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) shareSnapshot(prev, clone(next));
    const perCall = (performance.now() - t0) / 10;
    expect(perCall).toBeLessThan(20);
  });
});
