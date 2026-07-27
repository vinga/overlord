import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Regression test for the `--fork-session` clone split.
 *
 * Cloning runs `claude --resume <id> --fork-session --name "<name>___OVR:<pty>"`.
 * The CLI can emit TWO session IDs from one PTY process: an ephemeral initial
 * resume session (carries the ___OVR marker → links + gets the clone name) and
 * then the actual fork, whose {pid}.json is rewritten with a NEW sessionId, a
 * NEW startedAt, and the --name marker DROPPED.
 *
 * The fork therefore matches neither the marker path (no marker) nor the
 * startedAt-gated /clear path (bumped startedAt), so without the fix it appears
 * as a nameless orphan worker while the named clone goes "closed" / "Session
 * exited". relinkForkByOwnedPid() recognizes the fork by its owned-PTY pid and
 * folds it back into the clone's lineage.
 *
 * This reproduces the split deterministically — the live race is intermittent.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-fork-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Minimal PtyManager stand-in: a marker→pid table backing the three methods
 *  the session-event handlers call (has / getPid / findByPid). */
function makeFakePtyManager() {
  const byMarker = new Map<string, number>();
  return {
    add: (marker: string, pid: number) => byMarker.set(marker, pid),
    has: (marker: string) => byMarker.has(marker),
    getPid: (marker: string) => byMarker.get(marker),
    findByPid: (pid: number) => {
      for (const [marker, p] of byMarker) if (p === pid) return marker;
      return undefined;
    },
  };
}

async function makeCtx() {
  const smMod = await import('../session/stateManager.js');
  const trackerMod = await import('../session/ptyLinkageTracker.js');
  const stateManager = new smMod.StateManager(() => { /* noop */ });
  const linkageTracker = new trackerMod.PtyLinkageTracker();
  const ptyManager = makeFakePtyManager();
  const broadcasts: Array<Record<string, unknown>> = [];

  const ctx = {
    stateManager,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ptyManager: ptyManager as any,
    aiClassifier: {} as any,
    wsSessionMap: new Map(),
    ovrToPty: new Map<string, string>(),
    ptyToOvr: new Map<string, string>(),
    linkageTracker,
    ptyOutputBuffer: new Map(),
    broadcastRaw: (msg: Record<string, unknown>) => { broadcasts.push(msg); },
    sendToClient: () => { /* noop */ },
    isStartupComplete: () => true,
  };

  const watcher = new EventEmitter();
  const handlersMod = await import('../session/sessionEventHandlers.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlersMod.registerSessionEventHandlers(watcher as any, ctx as any);

  return { ctx, watcher, ptyManager, broadcasts, stateManager, linkageTracker };
}

const CWD = '/tmp/fork-test-cwd';

describe('relinkForkByOwnedPid — --fork-session clone split', () => {
  it('folds the nameless fork back into the clone lineage (no orphan, no "Session exited")', async () => {
    const { ctx, watcher, ptyManager, broadcasts, stateManager, linkageTracker } = await makeCtx();
    const PID = 50001;
    const MARKER = 'pty-fork-1';
    const INITIAL = 'initial-sid-aaaa';
    const FORK = 'fork-sid-bbbb';
    const PARENT = 'true-parent-sid';

    // PTY is alive and a clone is pending on it.
    ptyManager.add(MARKER, PID);
    linkageTracker.trackCloneInfo(MARKER, { name: 'OV Tarn (1)', originalSessionId: PARENT });

    // 1) Initial resume session carries the marker → links + clone info applied.
    watcher.emit('added', { sessionId: INITIAL, pid: PID, cwd: CWD, name: `OV Tarn (1)___OVR:${MARKER}`, startedAt: 1000 });

    const ovrId = ctx.ptyToOvr.get(MARKER);
    expect(ovrId).toBeTruthy();
    expect(stateManager.getActiveClaudeByOvr(ovrId!)?.sessionId).toBe(INITIAL);
    expect(stateManager.getSession(INITIAL)?.resumedFrom).toBe(PARENT);

    // 2) The fork: new sid, SAME pid, DIFFERENT startedAt, NO marker.
    watcher.emit('changed', { sessionId: FORK, pid: PID, cwd: CWD, startedAt: 2000 });

    // Fork inherited the clone's ovrId and is now the one live session for it.
    expect(stateManager.getActiveClaudeByOvr(ovrId!)?.sessionId).toBe(FORK);
    // The ephemeral initial session is gone — not a separate orphan worker.
    expect(stateManager.getSession(INITIAL)).toBeUndefined();
    // PTY routing still points at the same ovrId (now → fork).
    expect(ctx.ptyToOvr.get(MARKER)).toBe(ovrId);
    // Clone name carried over to the fork.
    expect(stateManager.getSession(FORK)?.proposedName).toBe('OV Tarn (1)');
    // resumedFrom points at the TRUE parent, not the deleted initial session,
    // so the cloned conversation still resolves the parent transcript.
    expect(stateManager.getSession(FORK)?.resumedFrom).toBe(PARENT);

    // A session:replaced was broadcast for the swap.
    expect(broadcasts.some(b => b.type === 'session:replaced' && b.oldSessionId === INITIAL && b.newSessionId === FORK)).toBe(true);
  });

  it('does NOT relink a same-pid session for a pid we do not own (external /clear stays on its own path)', async () => {
    const { ctx, watcher, stateManager } = await makeCtx();
    const PID = 60002;
    const A = 'external-a';
    const B = 'external-b';

    // No PTY registered for this pid → not owned by Overlord.
    watcher.emit('added', { sessionId: A, pid: PID, cwd: CWD, startedAt: 1000 });
    const ovrA = stateManager.getSession(A)?.overlordId;
    expect(ovrA).toBeTruthy();

    // A second session, same pid, no marker — must NOT be folded via the owned-PTY path.
    watcher.emit('changed', { sessionId: B, pid: PID, cwd: CWD, startedAt: 2000 });

    // B did not inherit A's ovrId through relinkForkByOwnedPid (no PTY owned).
    expect(stateManager.getSession(B)?.overlordId).not.toBe(ovrA);
    expect(ctx.ptyToOvr.size).toBe(0);
  });
});
