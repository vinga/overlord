import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-permmode-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshStateManager(onChange: () => void = () => {}) {
  const mod = await import('../session/stateManager.js');
  return new mod.StateManager(onChange);
}

/**
 * StateManager.onChange() throttles broadcasts to 5Hz via a 200ms timer (and
 * coalesces every call made inside that window into one). Waiting a single
 * event-loop tick is not enough to observe a broadcast — wait past the window.
 */
const BROADCAST_THROTTLE_MS = 200;
function flushBroadcast(): Promise<void> {
  return new Promise(r => setTimeout(r, BROADCAST_THROTTLE_MS + 60));
}

describe('setPermissionMode — basic contract', () => {
  it('sets mode and activates the lock', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    sm.setPermissionMode('sid-1', 'plan');
    const s = sm.getSession('sid-1');
    expect(s?.permissionMode).toBe('plan');
    expect(s?.permissionModeLockedUntil).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('sets mode to "default" — chip should remain (default is truthy)', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    sm.setPermissionMode('sid-1', 'default');
    const s = sm.getSession('sid-1');
    expect(s?.permissionMode).toBe('default');
    expect(s?.permissionMode).toBeTruthy();
  });

  it('resolves ovrId → claudeId so PTY-origin calls still hit the session', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    const ovrId = sm.getSession('sid-1')?.overlordId!;
    expect(ovrId).toBeDefined();

    sm.setPermissionMode(ovrId, 'acceptEdits');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('acceptEdits');
  });

  it('is a no-op for unknown session id', async () => {
    const sm = await freshStateManager();
    expect(() => sm.setPermissionMode('unknown-sid', 'plan')).not.toThrow();
  });

  it('fires onChange only when mode actually changes', async () => {
    let calls = 0;
    const sm = await freshStateManager(() => { calls++; });
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    // Flush the scheduled onChange from addOrUpdate before counting.
    await flushBroadcast();
    const baseline = calls;

    sm.setPermissionMode('sid-1', 'plan');
    await flushBroadcast();
    expect(calls).toBe(baseline + 1);

    // Same value — no new onChange fires.
    sm.setPermissionMode('sid-1', 'plan');
    await flushBroadcast();
    expect(calls).toBe(baseline + 1);

    // Different value — onChange fires again.
    sm.setPermissionMode('sid-1', 'default');
    await flushBroadcast();
    expect(calls).toBe(baseline + 2);
  });
});

describe('addOrUpdate — lock preservation across rebuilds', () => {
  it('preserves permissionMode when lock is active (transcript cannot overwrite)', async () => {
    const sm = await freshStateManager();
    // Initial: session with transcript permMode='acceptEdits'
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    // Realtime detection sets mode to 'plan' (locks it)
    sm.setPermissionMode('sid-1', 'plan');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('plan');

    // Transcript rebuild arrives with stale permMode='acceptEdits'.
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    // Lock must keep the realtime value.
    expect(sm.getSession('sid-1')?.permissionMode).toBe('plan');
    expect(sm.getSession('sid-1')?.permissionModeLockedUntil).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('preserves "default" across rebuilds (default is a real locked value)', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    sm.setPermissionMode('sid-1', 'default');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('default');

    // Multiple rebuilds — 'default' must survive.
    for (let i = 0; i < 3; i++) {
      sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    }

    expect(sm.getSession('sid-1')?.permissionMode).toBe('default');
  });

  it('preserves lock across rebuilds: permissionModeLockedUntil stays at MAX_SAFE_INTEGER', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    sm.setPermissionMode('sid-1', 'plan');

    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    expect(sm.getSession('sid-1')?.permissionModeLockedUntil).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('cycle simulation — rapid setPermissionMode calls', () => {
  it('each cycle sets new mode and triggers broadcast', async () => {
    let snapshots = 0;
    const sm = await freshStateManager(() => { snapshots++; });
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });
    await flushBroadcast();
    const baseline = snapshots;

    // Simulate user clicking chip three times: default → acceptEdits → plan → default.
    // Each click is flushed past the throttle window, so each gets its own broadcast
    // (clicks made inside one 200ms window would legitimately coalesce into one).
    sm.setPermissionMode('sid-1', 'acceptEdits');
    await flushBroadcast();
    expect(sm.getSession('sid-1')?.permissionMode).toBe('acceptEdits');

    sm.setPermissionMode('sid-1', 'plan');
    await flushBroadcast();
    expect(sm.getSession('sid-1')?.permissionMode).toBe('plan');

    sm.setPermissionMode('sid-1', 'default');
    await flushBroadcast();
    expect(sm.getSession('sid-1')?.permissionMode).toBe('default');

    expect(snapshots).toBe(baseline + 3);
  });

  it('late PTY detection fires AFTER cycle endpoint — last setter wins', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sid-1', pid: 100, cwd: '/tmp/a', startedAt: 1000 });

    // Cycle endpoint sets 'default' immediately.
    sm.setPermissionMode('sid-1', 'default');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('default');

    // PTY detection from the post-shift+tab TUI redraw arrives with the same value.
    sm.setPermissionMode('sid-1', 'default');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('default');

    // But if detection has a stale buffer and sees "plan" again, it overwrites —
    // this is a real concern the UI sees as "chip reverted after clicking".
    sm.setPermissionMode('sid-1', 'plan');
    expect(sm.getSession('sid-1')?.permissionMode).toBe('plan');
  });
});
