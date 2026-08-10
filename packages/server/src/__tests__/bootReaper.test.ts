import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

// liveAtShutdownStore resolves its paths from os.homedir() at module load, so
// each test gets an isolated fake home (via $HOME) and a fresh import. Without
// this the reaper would read the real ~/.claude/overlord/live-pty.json and
// could kill the developer's own live sessions.
let HOME: string;
const REAL_HOME = process.env.HOME;

async function loadReaper() {
  vi.resetModules();
  return await import('../session/bootReaper.js');
}

function heartbeatFile(): string {
  return path.join(HOME, '.claude', 'overlord', 'live-pty.json');
}

function writeHeartbeat(entries: Array<{ ovrId: string; sessionId: string; pid: number }>): void {
  fs.mkdirSync(path.dirname(heartbeatFile()), { recursive: true });
  fs.writeFileSync(heartbeatFile(), JSON.stringify({ updatedAt: new Date().toISOString(), entries }));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spawned: ChildProcess[] = [];

/** Stand-in for an orphaned PTY child: its argv[0] carries the ___OVR: marker
 *  and the recorded sid, exactly what isOverlordPtyProcess matches on. */
function spawnFakeSession(sessionId: string): ChildProcess {
  const p = spawn('sh', ['-c', `exec -a "claude --resume ${sessionId} --name ___OVR:pty-test" sleep 120`], { stdio: 'ignore' });
  spawned.push(p);
  return p;
}

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-reap-'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.OVERLORD_BOOT_REAP;
});

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { if (p.pid) process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('reapPreviousInstance', () => {
  it('kills an orphan whose cmdline carries the marker and sid', async () => {
    const { reapPreviousInstance } = await loadReaper();
    const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const orphan = spawnFakeSession(sid);
    await settle(400);
    writeHeartbeat([{ ovrId: 'ovr-test', sessionId: sid, pid: orphan.pid! }]);

    expect(reapPreviousInstance()).toBe(1);
    await settle(700);
    expect(alive(orphan.pid!)).toBe(false);
  });

  it('leaves the heartbeat file in place for the consume step', async () => {
    const { reapPreviousInstance } = await loadReaper();
    const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
    const orphan = spawnFakeSession(sid);
    await settle(400);
    writeHeartbeat([{ ovrId: 'ovr-test', sessionId: sid, pid: orphan.pid! }]);

    reapPreviousInstance();
    // consumeLivePtyFallback still owns deletion — reaping must not consume.
    expect(fs.existsSync(heartbeatFile())).toBe(true);
  });

  it('skips a recycled pid whose cmdline does not match', async () => {
    const { reapPreviousInstance } = await loadReaper();
    // No ___OVR: marker, started after this process — the pid-reuse case.
    const stranger = spawn('sleep', ['120'], { stdio: 'ignore' });
    spawned.push(stranger);
    await settle(400);
    writeHeartbeat([{ ovrId: 'ovr-test', sessionId: 'cccccccc-1111-2222-3333-444444444444', pid: stranger.pid! }]);

    expect(reapPreviousInstance()).toBe(0);
    await settle(300);
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('does nothing when OVERLORD_BOOT_REAP=0', async () => {
    const { reapPreviousInstance } = await loadReaper();
    const sid = 'dddddddd-1111-2222-3333-444444444444';
    const orphan = spawnFakeSession(sid);
    await settle(400);
    writeHeartbeat([{ ovrId: 'ovr-test', sessionId: sid, pid: orphan.pid! }]);

    process.env.OVERLORD_BOOT_REAP = '0';
    expect(reapPreviousInstance()).toBe(0);
    await settle(300);
    expect(alive(orphan.pid!)).toBe(true);
  });

  it('no-ops with no heartbeat and with an empty one', async () => {
    const { reapPreviousInstance } = await loadReaper();
    expect(reapPreviousInstance()).toBe(0);
    writeHeartbeat([]);
    expect(reapPreviousInstance()).toBe(0);
  });

  it('never signals this process', async () => {
    const { reapPreviousInstance } = await loadReaper();
    writeHeartbeat([{ ovrId: 'ovr-self', sessionId: 'self', pid: process.pid }]);
    expect(reapPreviousInstance()).toBe(0);
    expect(alive(process.pid)).toBe(true);
  });
});
