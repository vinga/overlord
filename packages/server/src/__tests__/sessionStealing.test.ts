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
    // Replacement allowed: pid updated, lineage (ovrId) preserved.
    expect(after?.pid).toBe(200);
    expect(after?.overlordId).toBe(ovr);
    // startedAt is a LINEAGE property, pinned to the first-observed value — it is
    // deliberately NOT advanced by a resume. Letting the new process's startedAt
    // win would reorder rooms by recency on every restart / auto-resume.
    expect(after?.startedAt).toBe(1000);
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

describe('session stealing — fresh spawn does not inherit stale pendingResume from same cwd', () => {
  it('marks fresh PTY spawn via trackPendingPtySpawn(cwd, ptyId) so addOrUpdate skips pendingResumes', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    const parentSid = 'jovian-parent';

    // Earlier in the session, user resumed Jovian — pendingResume is set.
    sm.trackPendingResume(cwd, parentSid);

    // Later, user creates a fresh session in the same cwd. The fresh spawn
    // is registered with its ptyId so addOrUpdate can identify it.
    const freshPtyId = 'pty-fresh-123';
    sm.trackPendingPtySpawn(cwd, freshPtyId);

    // The fresh PTY's session file arrives. Its name contains the marker.
    sm.addOrUpdate({
      sessionId: 'gale-sid',
      pid: 72957,
      cwd,
      startedAt: 9999,
      name: `Gale___OVR:${freshPtyId}`,
    });

    const gale = sm.getSession('gale-sid');
    // Gale must NOT have inherited Jovian's resumedFrom from the stale
    // pendingResume entry.
    expect(gale?.resumedFrom).toBeUndefined();
  });

  it('fresh marker survives multiple addOrUpdate calls for the same PTY', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    sm.trackPendingResume(cwd, 'stale-parent');
    const freshPtyId = 'pty-multi-call';
    sm.trackPendingPtySpawn(cwd, freshPtyId);

    // trackPendingPtySpawn with a ptyId must also nuke stale pendingResume.
    expect(sm.hasPendingResume(cwd)).toBe(false);

    // First addOrUpdate (e.g. 'added' event).
    sm.addOrUpdate({
      sessionId: 'neda-sid',
      pid: 100,
      cwd,
      startedAt: 1000,
      name: `Neda___OVR:${freshPtyId}`,
    });
    expect(sm.getSession('neda-sid')?.resumedFrom).toBeUndefined();

    // Second addOrUpdate (e.g. 'changed' event) — marker must still be
    // recognized as fresh (not consumed on first call).
    sm.addOrUpdate({
      sessionId: 'neda-sid',
      pid: 100,
      cwd,
      startedAt: 1000,
      name: `Neda___OVR:${freshPtyId}`,
    });
    expect(sm.getSession('neda-sid')?.resumedFrom).toBeUndefined();
  });

  it('marks all concurrent PTY spawns in same cwd as embedded via marker', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    const ptyA = 'pty-A', ptyB = 'pty-B', ptyC = 'pty-C';

    // Three spawns in the same cwd back-to-back. The cwd-keyed pendingPtySpawns
    // entry gets overwritten by each call; only ptyId-keyed freshPtySpawns
    // preserves a per-spawn fingerprint that lets each Claude session find its
    // own match.
    sm.trackPendingPtySpawn(cwd, ptyA);
    sm.trackPendingPtySpawn(cwd, ptyB);
    sm.trackPendingPtySpawn(cwd, ptyC);

    sm.addOrUpdate({ sessionId: 's1', pid: 100, cwd, startedAt: 1000, name: `Alpha___OVR:${ptyA}` });
    sm.addOrUpdate({ sessionId: 's2', pid: 101, cwd, startedAt: 1001, name: `Beta___OVR:${ptyB}` });
    sm.addOrUpdate({ sessionId: 's3', pid: 102, cwd, startedAt: 1002, name: `Gamma___OVR:${ptyC}` });

    expect(sm.getSession('s1')?.sessionType).toBe('embedded');
    expect(sm.getSession('s2')?.sessionType).toBe('embedded');
    expect(sm.getSession('s3')?.sessionType).toBe('embedded');
  });

  it('a real resume still populates resumedFrom (no marker in raw.name → falls through to pendingResumes)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    const parentSid = 'jovian-parent';

    sm.trackPendingResume(cwd, parentSid);

    // Resume spawns a PTY but does NOT mark it as fresh. The session settles
    // with a new sid; addOrUpdate picks up the pending resume.
    sm.addOrUpdate({
      sessionId: 'new-resume-sid',
      pid: 1234,
      cwd,
      startedAt: 5555,
      // no name with fresh marker
    });

    expect(sm.getSession('new-resume-sid')?.resumedFrom).toBe(parentSid);
  });
});

describe('session stealing — resumedFrom self-loop guard', () => {
  it('does not set resumedFrom when the pending resume target equals the incoming sessionId', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/projects/overlord';
    const sid = 'viktor-sid';

    // User clicks Resume on Viktor — pendingResume[cwd] = viktor-sid
    sm.trackPendingResume(cwd, sid);

    // `--resume` spawns Claude which takes over the same sid (common when
    // the old process was already dead). Incoming sessionId matches the
    // pending resume target.
    sm.addOrUpdate({ sessionId: sid, pid: 77849, cwd, startedAt: 1000 });

    const v = sm.getSession(sid);
    expect(v).toBeDefined();
    // Self-loop must not persist — resumedFrom pointing at self breaks
    // transcript fallback resolution.
    expect(v?.resumedFrom).toBeUndefined();
  });
});

describe('/clear inside --resumed session — in-place transcript truncation', () => {
  it('readTranscriptState flags transcriptTruncated when file shrinks between reads', async () => {
    const reader = await import('../session/transcriptReader.js');
    const transcriptPath = path.join(tmpHome, '.claude', 'projects', 'clear-test.jsonl');

    // Pre-clear: a few turns in the transcript.
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `msg ${i}` },
        timestamp: new Date(Date.now() - (10 - i) * 1000).toISOString(),
        sessionId: 'viktor',
      }));
    }
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
    const first = reader.readTranscriptState(transcriptPath);
    expect(first.transcriptTruncated).toBeUndefined();

    // /clear rewrites the same file smaller. Force a distinct mtime so the
    // reader doesn't take the unchanged fast path.
    const later = Date.now() / 1000 + 1;
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hey there' },
      timestamp: new Date().toISOString(),
      sessionId: 'viktor',
    }) + '\n');
    fs.utimesSync(transcriptPath, later, later);
    reader.markTranscriptDirty(transcriptPath);

    const second = reader.readTranscriptState(transcriptPath);
    expect(second.transcriptTruncated).toBe(true);
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
