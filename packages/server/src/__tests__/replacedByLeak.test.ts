import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tests for the replacedBy snapshot leak (plan:
 * artifact-mp6t2atl-hal489mn). Persistent replacedBy on the sessionStore
 * record must hide the session from the snapshot even when the in-memory
 * Session.replacedBy is undefined — which happens whenever addOrUpdate
 * rebuilds the Session literal without preserving the field.
 *
 * Also covers the orphan-successor scrub.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-replacedby-'));
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
  const sm = new mod.StateManager(() => { /* noop */ });
  return sm;
}

describe('replacedBy snapshot leak', () => {
  it('snapshot hides session when sessionStore.replacedBy is set but Session.replacedBy is undefined', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/replaced-by-leak';

    // Set up two sessions in the same room: A (will be marked replaced) and C (the genuine active one).
    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000, name: 'Vorin' });
    await new Promise(r => setTimeout(r, 5));
    sm.addOrUpdate({ sessionId: 'sid-C', pid: 200, cwd, startedAt: 2000, name: 'Vorin' });

    const sessionStore = (await import('../session/sessionStore.js')).sessionStore;
    const ovrA = sm.getSession('sid-A')?.overlordId;
    expect(ovrA).toBeDefined();
    // Persist replacedBy on A's ovr record. The successor sid is "sid-B" — a
    // transient sid that lives elsewhere; we don't need it in this state
    // manager to exercise the leak filter.
    sessionStore.patch(ovrA!, { replacedBy: 'sid-B' });

    // Trigger a fresh addOrUpdate for A. This rebuilds the in-memory Session
    // literal (stateManager.ts :760) which omits replacedBy — exactly the
    // leak path that bit us.
    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000, name: 'Vorin' });
    expect(sm.getSession('sid-A')?.replacedBy).toBeUndefined();

    // Snapshot must still hide A — projection-first filter consults
    // sessionStore.replacedBy via the prebuilt replacedOvrIds Set.
    const snap = sm.getSnapshot();
    const flat = snap.rooms.flatMap(r => r.sessions);
    expect(flat.find(s => s.sessionId === 'sid-A')).toBeUndefined();
    // C remains visible.
    expect(flat.find(s => s.sessionId === 'sid-C')).toBeDefined();
  });

  it('self-referential replacedBy does not hide the session (snapshot filter ignores it)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/replaced-by-selfref';

    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000, name: 'Self' });

    const sessionStore = (await import('../session/sessionStore.js')).sessionStore;
    const ovrA = sm.getSession('sid-A')?.overlordId!;
    // Stale self-reference. The composeSession :2242 self-ref scrub and the
    // snapshot filter's `!== currentSessionId` guard must keep A visible.
    sessionStore.patch(ovrA, { replacedBy: 'sid-A' });

    const snap = sm.getSnapshot();
    const flat = snap.rooms.flatMap(r => r.sessions);
    expect(flat.find(s => s.sessionId === 'sid-A')).toBeDefined();
  });
});

describe('scrubReplacedBy', () => {
  it('clears orphan-successor pointers (successor sid not in any active lineage.history)', async () => {
    const sm = await freshStateManager();
    const { sessionStore, scrubReplacedBy } = await import('../session/sessionStore.js');

    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd: '/tmp/scrub-orphan', startedAt: 1000 });
    const ovrA = sm.getSession('sid-A')?.overlordId!;
    sessionStore.patch(ovrA, { replacedBy: 'sid-ghost-never-existed' });

    const result = scrubReplacedBy();
    expect(result.orphanSuccessor).toContain(ovrA);
    expect(sessionStore.getByOverlordId(ovrA)?.replacedBy).toBeUndefined();
  });

  it('preserves legitimate replacedBy where successor is in another record lineage', async () => {
    const sm = await freshStateManager();
    const { sessionStore, scrubReplacedBy } = await import('../session/sessionStore.js');

    // ovr-A.replacedBy points at sid-B; sid-B is the current sid of ovr-B.
    // The scrub must not touch A's pointer — sid-B is "in some active lineage".
    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd: '/tmp/scrub-keep', startedAt: 1000 });
    sm.addOrUpdate({ sessionId: 'sid-B', pid: 200, cwd: '/tmp/scrub-keep-b', startedAt: 2000 });
    const ovrA = sm.getSession('sid-A')?.overlordId!;
    sessionStore.patch(ovrA, { replacedBy: 'sid-B' });

    const result = scrubReplacedBy();
    expect(result.selfRef).not.toContain(ovrA);
    expect(result.orphanSuccessor).not.toContain(ovrA);
    expect(sessionStore.getByOverlordId(ovrA)?.replacedBy).toBe('sid-B');
  });
});
