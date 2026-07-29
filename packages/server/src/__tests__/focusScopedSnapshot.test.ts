import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import { join } from 'path';

// Isolate the on-disk session store per run, like the other stateManager tests.
const TMP = fs.mkdtempSync(join(os.tmpdir(), 'ovr-focus-'));
vi.stubEnv('OVERLORD_HOME', TMP);

const { StateManager } = await import('../session/stateManager.js');

type SM = InstanceType<typeof StateManager>;

function addSession(sm: SM, sessionId: string, cwd: string): void {
  sm.addOrUpdate({ pid: 0, sessionId, cwd, startedAt: Date.now() });
}

/** Give a session a feed + history directly — addOrUpdate rebuilds from the
 *  transcript, which these tests deliberately don't have.
 *
 *  `state` matters: composeSession drops the feed for closed sessions
 *  regardless of focus (pre-existing behaviour), and a pid-0 session with no
 *  transcript lands in 'closed'. Force a live state so these tests exercise the
 *  focus gate rather than the closed gate. */
function seed(sm: SM, sessionId: string, items: number): void {
  const s = sm.getSession(sessionId)!;
  s.state = 'waiting';
  s.activityFeed = Array.from({ length: items }, (_, i) => ({
    kind: 'message' as const,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `item ${i} `.repeat(20),
  }));
  s.sessionHistory = [{ sessionId, attachedAt: Date.now() }];
}

function findSession(snap: ReturnType<SM['getSnapshot']>, sessionId: string) {
  for (const r of snap.rooms) {
    for (const s of r.sessions) if (s.sessionId === sessionId) return s;
  }
  return undefined;
}

describe('focus-scoped snapshots', () => {
  let sm: SM;

  beforeEach(() => {
    sm = new StateManager(() => {});
    addSession(sm, 'sid-a', '/tmp/focus-room');
    addSession(sm, 'sid-b', '/tmp/focus-room');
    seed(sm, 'sid-a', 40);
    seed(sm, 'sid-b', 40);
  });

  it('omits activityFeed for every session when nothing is focused', () => {
    const snap = sm.getSnapshot();
    expect(findSession(snap, 'sid-a')?.activityFeed).toBeUndefined();
    expect(findSession(snap, 'sid-b')?.activityFeed).toBeUndefined();
  });

  it('includes activityFeed for the focused session only', () => {
    const ovrA = sm.getSession('sid-a')!.overlordId;
    const snap = sm.getSnapshot(ovrA);
    expect(findSession(snap, 'sid-a')?.activityFeed?.length).toBeGreaterThan(0);
    expect(findSession(snap, 'sid-b')?.activityFeed).toBeUndefined();
  });

  it('accepts a raw sessionId as focus, not just an ovrId', () => {
    // The client falls back to sessionId for pre-ovrId hashes and pending pty ids.
    const snap = sm.getSnapshot('sid-b');
    expect(findSession(snap, 'sid-b')?.activityFeed?.length).toBeGreaterThan(0);
    expect(findSession(snap, 'sid-a')?.activityFeed).toBeUndefined();
  });

  it('gates sessionHistory on focus and never sends transcriptPath', () => {
    const ovrA = sm.getSession('sid-a')!.overlordId;
    const snap = sm.getSnapshot(ovrA);
    expect(findSession(snap, 'sid-a')?.sessionHistory).toBeDefined();
    expect(findSession(snap, 'sid-b')?.sessionHistory).toBeUndefined();
    expect(findSession(snap, 'sid-a')?.transcriptPath).toBeUndefined();
    expect(findSession(snap, 'sid-b')?.transcriptPath).toBeUndefined();
  });

  it('sends hasActivity for every session so cards keep working', () => {
    const snap = sm.getSnapshot();
    expect(findSession(snap, 'sid-a')?.hasActivity).toBe(true);
    expect(findSession(snap, 'sid-b')?.hasActivity).toBe(true);
  });

  it('hasActivity is false for a session with no feed', () => {
    addSession(sm, 'sid-empty', '/tmp/focus-room');
    const snap = sm.getSnapshot();
    expect(findSession(snap, 'sid-empty')?.hasActivity).toBe(false);
  });

  it('focusing cuts the serialized payload substantially', () => {
    const ovrA = sm.getSession('sid-a')!.overlordId;
    const focused = JSON.stringify(sm.getSnapshot(ovrA)).length;
    const unfocused = JSON.stringify(sm.getSnapshot()).length;
    // One session's feed is present, the other's is gone.
    expect(focused).toBeGreaterThan(unfocused);
    // And both are far below what shipping every feed would cost.
    const everyFeed = 2 * JSON.stringify(sm.getSession('sid-a')!.activityFeed).length;
    expect(focused).toBeLessThan(everyFeed);
  });
});
