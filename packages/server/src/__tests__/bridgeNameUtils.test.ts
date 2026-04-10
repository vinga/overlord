import { describe, it, expect } from 'vitest';
import {
  normalizePipeName,
  derivePipeNameFromMarker,
  resolvePipeName,
  computeIsReconnect,
} from '../bridge/bridgeNameUtils.js';

// ─── normalizePipeName ────────────────────────────────────────────────────────

describe('normalizePipeName', () => {
  it('rewrites overlord-brg-{x} to overlord-new-{x}', () => {
    expect(normalizePipeName('overlord-brg-mntcq5ci')).toBe('overlord-new-mntcq5ci');
  });

  it('rewrites any overlord-brg- prefix regardless of suffix', () => {
    expect(normalizePipeName('overlord-brg-abc123')).toBe('overlord-new-abc123');
  });

  it('leaves already-correct overlord-new-{x} names unchanged', () => {
    expect(normalizePipeName('overlord-new-mntcq5ci')).toBe('overlord-new-mntcq5ci');
  });

  it('leaves unrelated pipe names unchanged', () => {
    expect(normalizePipeName('overlord-57dfd1eb')).toBe('overlord-57dfd1eb');
    expect(normalizePipeName('something-else')).toBe('something-else');
  });

  it('does not rewrite brg- appearing mid-string (only at position 0 of the name)', () => {
    // "overlord-brg-" must be the full start of the string
    expect(normalizePipeName('xoverlord-brg-abc')).toBe('xoverlord-brg-abc');
  });
});

// ─── derivePipeNameFromMarker ─────────────────────────────────────────────────

describe('derivePipeNameFromMarker', () => {
  it('strips brg- prefix and prepends overlord-new-', () => {
    expect(derivePipeNameFromMarker('brg-mntcq5ci')).toBe('overlord-new-mntcq5ci');
    expect(derivePipeNameFromMarker('brg-1a2b3c')).toBe('overlord-new-1a2b3c');
  });

  it('passes through markers without brg- prefix (manual spawns)', () => {
    expect(derivePipeNameFromMarker('57dfd1eb')).toBe('overlord-new-57dfd1eb');
    expect(derivePipeNameFromMarker('abc123')).toBe('overlord-new-abc123');
  });

  it('does not double-strip if suffix itself starts with brg-', () => {
    // "brg-brg-abc" → strips first "brg-" → "brg-abc" → "overlord-new-brg-abc"
    expect(derivePipeNameFromMarker('brg-brg-abc')).toBe('overlord-new-brg-abc');
  });
});

// ─── resolvePipeName ──────────────────────────────────────────────────────────

describe('resolvePipeName — no pending entry (manual bridge spawn)', () => {
  it('derives pipe from marker when no pending entry exists', () => {
    expect(resolvePipeName('brg-mntcq5ci', undefined, Date.now()))
      .toBe('overlord-new-mntcq5ci');
  });

  it('derives pipe from non-brg marker correctly', () => {
    expect(resolvePipeName('57dfd1eb', undefined, Date.now()))
      .toBe('overlord-new-57dfd1eb');
  });
});

describe('resolvePipeName — pending entry present and fresh', () => {
  it('uses pending pipeName verbatim when age is 0ms', () => {
    const now = Date.now();
    const pending = { pipeName: 'overlord-new-mntcq5ci', timestamp: now };
    expect(resolvePipeName('brg-mntcq5ci', pending, now)).toBe('overlord-new-mntcq5ci');
  });

  it('uses pending pipeName verbatim when age is exactly 29 999ms', () => {
    const now = 1_000_000;
    const pending = { pipeName: 'overlord-new-xyz', timestamp: now - 29_999 };
    expect(resolvePipeName('brg-xyz', pending, now)).toBe('overlord-new-xyz');
  });

  it('returns the pending pipeName even if it differs from what derivePipeNameFromMarker would give', () => {
    const now = Date.now();
    const pending = { pipeName: 'custom-pipe-name', timestamp: now };
    expect(resolvePipeName('brg-abc', pending, now)).toBe('custom-pipe-name');
  });
});

describe('resolvePipeName — pending entry expired', () => {
  it('returns null when age is exactly 30 001ms', () => {
    const now = 1_000_000;
    const pending = { pipeName: 'overlord-new-abc', timestamp: now - 30_001 };
    expect(resolvePipeName('brg-abc', pending, now)).toBeNull();
  });

  it('still valid at exactly 30 000ms (boundary: condition is strictly > 30 000)', () => {
    const now = 1_000_000;
    const pending = { pipeName: 'overlord-new-abc', timestamp: now - 30_000 };
    expect(resolvePipeName('brg-abc', pending, now)).toBe('overlord-new-abc');
  });

  it('returns null for very old entries', () => {
    const now = Date.now();
    const pending = { pipeName: 'overlord-new-old', timestamp: 0 };
    expect(resolvePipeName('brg-old', pending, now)).toBeNull();
  });
});

// ─── computeIsReconnect ───────────────────────────────────────────────────────

describe('computeIsReconnect', () => {
  it('returns false for a session never seen before', () => {
    const set = new Set<string>();
    expect(computeIsReconnect(set, 'session-a')).toBe(false);
  });

  it('adds the sessionId to the set after the first call', () => {
    const set = new Set<string>();
    computeIsReconnect(set, 'session-a');
    expect(set.has('session-a')).toBe(true);
  });

  it('returns true on the second call for the same sessionId', () => {
    const set = new Set<string>();
    computeIsReconnect(set, 'session-a'); // first connect
    expect(computeIsReconnect(set, 'session-a')).toBe(true); // reconnect
  });

  it('different sessions are independent', () => {
    const set = new Set<string>();
    expect(computeIsReconnect(set, 'session-a')).toBe(false);
    expect(computeIsReconnect(set, 'session-b')).toBe(false); // also first time
    expect(computeIsReconnect(set, 'session-a')).toBe(true);  // second time
    expect(computeIsReconnect(set, 'session-b')).toBe(true);  // second time
  });

  it('has() is called before add() — same-call mutation cannot affect the result', () => {
    // This test encodes the invariant: if add() were called first, the first call
    // would return true (wrong). Verify the order by checking we get false first.
    const set = new Set<string>();
    const first = computeIsReconnect(set, 'x');
    expect(first).toBe(false); // must be false, not true
  });
});
