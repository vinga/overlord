import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tests for the "session stealing" bug: when two PTYs `--resume` the same
 * parent sessionId, the new PTY's session file briefly reports the parent
 * sessionId with a fresh pid. Without a startedAt guard, addOrUpdate would
 * overwrite the existing entry's pid; subsequently findSessionByPid would
 * match the wrong session and transferSessionState would move the ovrId.
 *
 * The fix: addOrUpdate must not overwrite pid when (sessionId matches but
 * startedAt differs); findSessionByPid must require startedAt to match.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-test-'));
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
  // Reset module cache so os.homedir() re-reads env inside the module.
  const mod = await import('../session/stateManager.js');
  const sm = new mod.StateManager(() => { /* noop */ });
  return sm;
}

describe('session stealing — addOrUpdate pid guard', () => {
  it('does not overwrite pid when same sessionId arrives with a different startedAt', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/fake-project';
    const sessionId = 'parent-session-uuid';

    // First resume: Willow with pid 100, startedAt T0
    sm.addOrUpdate({ sessionId, pid: 100, cwd, startedAt: 1000 });
    const willow = sm.getSession(sessionId);
    expect(willow?.pid).toBe(100);
    expect(willow?.startedAt).toBe(1000);
    const willowOvr = willow?.overlordId;
    expect(willowOvr).toBeDefined();

    // Second resume arrives with SAME sessionId but different pid/startedAt.
    // This is the race: a second --resume wrote its {pid}.json with the parent sid.
    sm.addOrUpdate({ sessionId, pid: 200, cwd, startedAt: 2000 });

    const after = sm.getSession(sessionId);
    // The in-memory entry MUST retain Willow's pid — not silently jump to 200.
    expect(after?.pid).toBe(100);
    expect(after?.startedAt).toBe(1000);
    // OvrId must remain Willow's.
    expect(after?.overlordId).toBe(willowOvr);
  });

  it('DOES update pid when sessionId matches and startedAt matches (same session, normal update)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/fake-project';
    const sessionId = 'sess-1';

    sm.addOrUpdate({ sessionId, pid: 100, cwd, startedAt: 1000 });
    // Normal refresh: same startedAt, same pid — should succeed without error.
    sm.addOrUpdate({ sessionId, pid: 100, cwd, startedAt: 1000 });
    expect(sm.getSession(sessionId)?.pid).toBe(100);
  });

  it('ALLOWS pid replacement when existing session is CLOSED (legit resume of dead session)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/fake-project';
    const sessionId = 'kagami-sid';

    // Existing Kagami: live first
    sm.addOrUpdate({ sessionId, pid: 100, cwd, startedAt: 1000 });
    const ovr = sm.getSession(sessionId)?.overlordId;

    // Kagami dies — mark closed.
    sm.markClosed(sessionId);
    expect(sm.getSession(sessionId)?.state).toBe('closed');

    // User clicks Resume → new PTY's session file briefly reports kagami-sid
    // with a fresh pid/startedAt.
    sm.addOrUpdate({ sessionId, pid: 200, cwd, startedAt: 2000 });

    const after = sm.getSession(sessionId);
    // Replacement allowed: pid/startedAt updated, lineage (ovrId) preserved.
    expect(after?.pid).toBe(200);
    expect(after?.startedAt).toBe(2000);
    expect(after?.overlordId).toBe(ovr);
  });
});

describe('session stealing — findSessionByPid startedAt guard', () => {
  it('returns a match when pid AND startedAt both match', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sess-a', pid: 500, cwd: '/tmp/x', startedAt: 1000 });

    // A /clear in place: same pid, same startedAt, new sid.
    const match = sm.findSessionByPid(500, 'sess-new', 1000);
    expect(match?.sessionId).toBe('sess-a');
  });

  it('does NOT match when pid matches but startedAt differs (pid reuse / concurrent resume)', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sess-a', pid: 500, cwd: '/tmp/x', startedAt: 1000 });

    // A different process reusing pid 500, or a concurrent --resume with a new pid.
    const match = sm.findSessionByPid(500, 'sess-new', 9999);
    expect(match).toBeUndefined();
  });

  it('excludes the session identified by excludeSessionId', async () => {
    const sm = await freshStateManager();
    sm.addOrUpdate({ sessionId: 'sess-a', pid: 500, cwd: '/tmp/x', startedAt: 1000 });
    const match = sm.findSessionByPid(500, 'sess-a', 1000);
    expect(match).toBeUndefined();
  });
});

describe('session stealing — end-to-end Willow/Isolde scenario', () => {
  it('Isolde does not inherit Willow\'s ovrId when both --resume the same parent', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    const parentSid = 'f82ddc2e-parent';

    // 1. Willow spawns first. Her session file briefly reports the parent sid.
    sm.addOrUpdate({ sessionId: parentSid, pid: 56372, cwd, startedAt: 100 });
    const willowOvr = sm.getSession(parentSid)?.overlordId;
    expect(willowOvr).toBeDefined();

    // 2. Isolde spawns 4s later, also --resume of parent. Her session file
    //    briefly reports the SAME parent sid but with her own pid/startedAt.
    sm.addOrUpdate({ sessionId: parentSid, pid: 56504, cwd, startedAt: 200 });

    // Willow's pid must not have been stolen.
    expect(sm.getSession(parentSid)?.pid).toBe(56372);

    // 3. Isolde's session file updates to her real sid 166fd747.
    //    Simulate the 'changed' flow: findSessionByPid must NOT return Willow.
    const falseMatch = sm.findSessionByPid(56504, '166fd747-isolde', 200);
    expect(falseMatch).toBeUndefined();

    // 4. Isolde is registered fresh with her own ovrId.
    sm.addOrUpdate({ sessionId: '166fd747-isolde', pid: 56504, cwd, startedAt: 200 });
    const isolde = sm.getSession('166fd747-isolde');
    expect(isolde).toBeDefined();
    expect(isolde?.overlordId).not.toBe(willowOvr);

    // Willow still holds her original ovrId.
    expect(sm.getSession(parentSid)?.overlordId).toBe(willowOvr);
  });
});
