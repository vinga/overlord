import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Regression tests for session unification — the contract that lineage-scoped
 * fields are persisted through `sessionStore` (not duplicated on disk) and that
 * `markDeleted` is in-memory only with a 60s TTL.
 *
 * Risks:
 * - A future edit removes the `sessionStore.patch` next to a live mutation,
 *   reintroducing drift between `Session.X` and `OverlordSession.X`.
 * - A future edit re-adds disk persistence for the deleted-sids tombstone,
 *   reverting the deleted-sessions.json retirement.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-unify-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshStateManager() {
  const mod = await import('../session/stateManager.js');
  return new mod.StateManager(() => { /* noop */ });
}

describe('drift fixes — live mutations also patch sessionStore', () => {
  it('setIntent writes intent to OverlordSession via sessionStore', async () => {
    const sm = await freshStateManager();
    const { sessionStore } = await import('../session/sessionStore.js');
    sm.addOrUpdate({ sessionId: 'sid-intent', pid: 200, cwd: '/tmp/unify', startedAt: 1000 });
    const ovr = sm.getSession('sid-intent')?.overlordId!;
    expect(ovr).toBeDefined();

    sm.setIntent('sid-intent', 'refactor the inject scheduler');

    expect(sessionStore.getByOverlordId(ovr)?.intent).toBe('refactor the inject scheduler');
    expect(sm.getSession('sid-intent')?.intent).toBe('refactor the inject scheduler');
  });

  it('setSessionName writes proposedName to OverlordSession via sessionStore', async () => {
    const sm = await freshStateManager();
    const { sessionStore } = await import('../session/sessionStore.js');
    sm.addOrUpdate({ sessionId: 'sid-name', pid: 201, cwd: '/tmp/unify', startedAt: 1000 });
    const ovr = sm.getSession('sid-name')?.overlordId!;

    sm.setSessionName('sid-name', 'Linden');

    expect(sessionStore.getByOverlordId(ovr)?.proposedName).toBe('Linden');
    expect(sm.getSession('sid-name')?.proposedName).toBe('Linden');
  });

  it('setSessionColor writes color to OverlordSession via sessionStore', async () => {
    const sm = await freshStateManager();
    const { sessionStore } = await import('../session/sessionStore.js');
    sm.addOrUpdate({ sessionId: 'sid-color', pid: 202, cwd: '/tmp/unify', startedAt: 1000 });
    const ovr = sm.getSession('sid-color')?.overlordId!;

    const ok = sm.setSessionColor('sid-color', 'hsl(120, 50%, 50%)');

    expect(ok).toBe(true);
    expect(sessionStore.getByOverlordId(ovr)?.color).toBe('hsl(120, 50%, 50%)');
  });

  it('trackPendingResume writes pendingResume to OverlordSession via sessionStore', async () => {
    const sm = await freshStateManager();
    const { sessionStore } = await import('../session/sessionStore.js');
    const cwd = '/tmp/unify-resume';
    sm.addOrUpdate({ sessionId: 'sid-target', pid: 300, cwd, startedAt: 1000 });
    const ovr = sm.getSession('sid-target')?.overlordId!;

    sm.trackPendingResume(cwd, 'sid-target');

    const rec = sessionStore.getByOverlordId(ovr);
    expect(rec?.pendingResume).toBeDefined();
    expect(rec?.pendingResume?.cwd).toBe(cwd.toLowerCase());
    expect(typeof rec?.pendingResume?.at).toBe('number');
  });
});

describe('deleted-sids tombstone — in-memory only with TTL', () => {
  it('markDeleted does not write any file under ~/.claude/overlord/', async () => {
    const sm = await freshStateManager();
    const before = fs.readdirSync(path.join(tmpHome, '.claude', 'overlord'));
    sm.markDeleted('sid-tombstone-disk');
    const after = fs.readdirSync(path.join(tmpHome, '.claude', 'overlord'));
    expect(after).toEqual(before);
    expect(after).not.toContain('deleted-sessions.json');
  });

  it('isDeleted returns true immediately after markDeleted', async () => {
    const sm = await freshStateManager();
    sm.markDeleted('sid-tombstone-1');
    expect(sm.isDeleted('sid-tombstone-1')).toBe(true);
  });

  it('isDeleted returns false after the 60s TTL elapses (lazy evict)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const sm = await freshStateManager();
    sm.markDeleted('sid-tombstone-2');
    expect(sm.isDeleted('sid-tombstone-2')).toBe(true);

    // Advance just past the 60s TTL
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(sm.isDeleted('sid-tombstone-2')).toBe(false);
  });

  it('undelete clears the tombstone before TTL', async () => {
    const sm = await freshStateManager();
    sm.markDeleted('sid-tombstone-3');
    expect(sm.isDeleted('sid-tombstone-3')).toBe(true);
    sm.undelete('sid-tombstone-3');
    expect(sm.isDeleted('sid-tombstone-3')).toBe(false);
  });
});
