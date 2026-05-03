import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tests for OVR-marker-based session classification.
 *
 * Bug: after a server restart, `freshPtySpawns` is empty and `ptyManager` has
 * no live PTYs. Sessions that were spawned by Overlord (and carry `___OVR:<id>`
 * in their name) were being classified as `plain` instead of `embedded`.
 *
 * Fix: `addOrUpdate` now classifies any new session whose name contains
 * `___OVR:` as `embedded`, regardless of whether a live PTY or a fresh-spawn
 * timestamp can be found in memory.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-ovrmarker-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshStateManager() {
  const mod = await import('../session/stateManager.js');
  return new mod.StateManager(() => { /* noop */ });
}

describe('OVR marker classification — server-restart scenario', () => {
  it('classifies a session with ___OVR: marker as embedded even with no fresh spawn in memory', async () => {
    // Simulates: server restarted, freshPtySpawns empty, no live PTY.
    const sm = await freshStateManager();
    // No trackPendingPtySpawn call — as if we just restarted.
    sm.addOrUpdate({
      sessionId: 'maddox-sid',
      pid: 1234,
      cwd: '/tmp/parental-guard',
      startedAt: 1000,
      name: 'Maddox___OVR:pty-1777820912790-8yj6u2',
    });

    expect(sm.getSession('maddox-sid')?.sessionType).toBe('embedded');
  });

  it('classifies a session without ___OVR: marker as plain (not embedded) when no spawn is pending', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({
      sessionId: 'plain-sid',
      pid: 5678,
      cwd: '/tmp/some-project',
      startedAt: 2000,
      name: 'Balthazar',
    });

    expect(sm.getSession('plain-sid')?.sessionType).toBe('plain');
  });

  it('marker classification works with ovrId-style markers (post-refactor format)', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({
      sessionId: 'neo-sid',
      pid: 9999,
      cwd: '/tmp/neo-project',
      startedAt: 3000,
      name: 'Neo___OVR:ovr-abc123xyz',
    });

    expect(sm.getSession('neo-sid')?.sessionType).toBe('embedded');
  });

  it('fresh spawn path still works (isFreshByMarker takes priority, consumes the entry)', async () => {
    const sm = await freshStateManager();
    const ptyId = 'pty-fresh-111';
    sm.trackPendingPtySpawn('/tmp/fresh-project', ptyId);

    sm.addOrUpdate({
      sessionId: 'fresh-sid',
      pid: 1111,
      cwd: '/tmp/fresh-project',
      startedAt: 4000,
      name: `Aria___OVR:${ptyId}`,
    });

    expect(sm.getSession('fresh-sid')?.sessionType).toBe('embedded');
  });

  it('classifies as embedded when name=NONE on added but PTY spawn is pending (Celestine scenario)', async () => {
    // Claude writes {pid}.json without name first, then updates it.
    // The session watcher fires `added` (name=NONE) then `changed` (name with marker).
    // When `added` fires: no ovrMarker, but trackPendingPtySpawn was called.
    // The session must still get the correct reserved ovrId and be embedded.
    const sm = await freshStateManager();
    const cwd = '/tmp/parental-guard';
    const ptyId = 'pty-1777821503829-ecdw00';

    // Spawn-time setup: reserve ovrId + track pending spawn
    const reservedOvrId = sm.mintReservedOvrId(ptyId);
    sm.trackPendingPtySpawn(cwd, ptyId);

    // added event — name not yet written by Claude
    sm.addOrUpdate({
      sessionId: 'celestine-sid',
      pid: 16656,
      cwd,
      startedAt: 1000,
      // name: undefined — as Claude writes it initially
    });

    // The session should get the reserved ovrId (cwd-based lookup) and be embedded
    const after = sm.getSession('celestine-sid');
    expect(after?.sessionType).toBe('embedded');
    expect(after?.overlordId).toBe(reservedOvrId);
  });

  it('does NOT classify as embedded via cwd path when the 5s window has expired', async () => {
    // If enough time passes between trackPendingPtySpawn and session detection,
    // the cwd-based path must not fire (avoids false positives on long delays).
    const sm = await freshStateManager();
    const cwd = '/tmp/slow-project';
    const ptyId = 'pty-slow-999';

    vi.useFakeTimers();
    sm.mintReservedOvrId(ptyId);
    sm.trackPendingPtySpawn(cwd, ptyId);

    // Advance time past the 5s window before the session file appears.
    vi.advanceTimersByTime(6000);

    sm.addOrUpdate({
      sessionId: 'slow-sid',
      pid: 5555,
      cwd,
      startedAt: 1000,
      // no name — same as Celestine but after the window expired
    });

    vi.useRealTimers();
    // Window expired → cwd path must not fire → plain
    expect(sm.getSession('slow-sid')?.sessionType).toBe('plain');
  });

  it('uses reserved ovrId via cwd lookup (name=NONE), then ovrMarker on changed confirms same ovrId', async () => {
    // Full two-event cycle: added (name=NONE) then changed (name with marker).
    // Both calls must converge on the same ovrId and keep sessionType=embedded.
    const sm = await freshStateManager();
    const cwd = '/tmp/two-event-project';
    const ptyId = 'pty-two-event-abc';

    const reservedOvrId = sm.mintReservedOvrId(ptyId);
    sm.trackPendingPtySpawn(cwd, ptyId);

    // added — no name
    sm.addOrUpdate({ sessionId: 'two-event-sid', pid: 7777, cwd, startedAt: 1000 });
    expect(sm.getSession('two-event-sid')?.overlordId).toBe(reservedOvrId);
    expect(sm.getSession('two-event-sid')?.sessionType).toBe('embedded');

    // changed — name now includes marker
    sm.addOrUpdate({ sessionId: 'two-event-sid', pid: 7777, cwd, startedAt: 1000, name: `Echo___OVR:${ptyId}` });
    // Must stay embedded and not mint a second ovrId
    expect(sm.getSession('two-event-sid')?.overlordId).toBe(reservedOvrId);
    expect(sm.getSession('two-event-sid')?.sessionType).toBe('embedded');
  });

  it('resumed session inherits embedded type from parent via resumedFrom path', async () => {
    const sm = await freshStateManager();
    // Parent session was embedded.
    sm.addOrUpdate({
      sessionId: 'parent-sid',
      pid: 100,
      cwd: '/tmp/resume-project',
      startedAt: 1000,
      name: 'Parent___OVR:pty-original-111',
    });
    expect(sm.getSession('parent-sid')?.sessionType).toBe('embedded');

    // Resume creates a new session — no new OVR marker, pendingResume set.
    sm.trackPendingResume('/tmp/resume-project', 'parent-sid');
    sm.addOrUpdate({
      sessionId: 'resumed-sid',
      pid: 200,
      cwd: '/tmp/resume-project',
      startedAt: 2000,
      // No ___OVR: marker — plain resume
    });

    // New session should inherit embedded from parent.
    expect(sm.getSession('resumed-sid')?.resumedFrom).toBe('parent-sid');
    expect(sm.getSession('resumed-sid')?.sessionType).toBe('embedded');
  });
});
