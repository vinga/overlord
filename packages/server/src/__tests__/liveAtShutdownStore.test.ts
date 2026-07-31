import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// os.uptime() decides whether a heartbeat predates the current OS boot; pin it
// per test instead of depending on how long the CI box has been up. Everything
// else (notably homedir(), which honours $HOME) passes through.
const uptime = vi.hoisted(() => ({ seconds: 60 * 60 }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const patched = { ...actual, uptime: () => uptime.seconds };
  return { ...patched, default: patched };
});

// The store resolves its path from os.homedir() at module load, so each test
// gets an isolated fake home (via $HOME) and a freshly imported module.
let HOME: string;
const REAL_HOME = process.env.HOME;

async function loadStore() {
  vi.resetModules();
  return await import('../session/liveAtShutdownStore.js');
}

function captureFile(): string {
  return path.join(HOME, '.claude', 'overlord', 'live-at-shutdown.json');
}

function heartbeatFile(): string {
  return path.join(HOME, '.claude', 'overlord', 'live-pty.json');
}

/** Backdate the heartbeat's mtime so it looks written before the current OS
 *  boot (the "machine restarted" arm of the trust check). */
function backdateHeartbeat(msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(heartbeatFile(), t, t);
}

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-shutdown-'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  uptime.seconds = 60 * 60; // booted an hour ago unless a test says otherwise
});

afterEach(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('liveAtShutdownStore', () => {
  it('round-trips the captured entries', async () => {
    const { writeLiveAtShutdown, consumeLiveAtShutdown } = await loadStore();
    const entries = [
      { ovrId: 'ovr-a', sessionId: 'sid-a' },
      { ovrId: 'ovr-b', sessionId: 'sid-b' },
    ];
    writeLiveAtShutdown(entries);
    expect(consumeLiveAtShutdown()).toEqual(entries);
  });

  it('consumes once — a second read returns null', async () => {
    const { writeLiveAtShutdown, consumeLiveAtShutdown } = await loadStore();
    writeLiveAtShutdown([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);
    expect(consumeLiveAtShutdown()).toHaveLength(1);
    // Stale captures must never resume twice: the file is deleted on read, so a
    // later restart with no fresh shutdown sees "unknown", not the old set.
    expect(consumeLiveAtShutdown()).toBeNull();
    expect(fs.existsSync(captureFile())).toBe(false);
  });

  it('returns null when no capture exists (crash / kill -9)', async () => {
    const { consumeLiveAtShutdown } = await loadStore();
    expect(consumeLiveAtShutdown()).toBeNull();
  });

  it('writes an empty capture when nothing was live', async () => {
    const { writeLiveAtShutdown, consumeLiveAtShutdown } = await loadStore();
    writeLiveAtShutdown([]);
    // Empty array, NOT null — a clean shutdown with zero live PTYs is a known
    // answer ("resume nothing"), distinct from a missing capture.
    expect(consumeLiveAtShutdown()).toEqual([]);
  });

  it('drops malformed entries and survives corrupt JSON', async () => {
    const { consumeLiveAtShutdown } = await loadStore();
    const file = captureFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      entries: [{ ovrId: 'ovr-a', sessionId: 'sid-a' }, { ovrId: 'ovr-b' }, null, 'nope'],
    }));
    expect(consumeLiveAtShutdown()).toEqual([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);

    fs.writeFileSync(file, '{ not json');
    expect(consumeLiveAtShutdown()).toBeNull();
    // Corrupt file is removed so it can't poison every subsequent boot.
    expect(fs.existsSync(file)).toBe(false);
  });
});

// The heartbeat is the unclean-death path: a computer restart kills the server
// with SIGHUP/SIGKILL, so shutdown() never writes a capture. It may only be
// trusted when no recorded PTY child can still be running.
describe('live-pty heartbeat', () => {
  const DEAD_PID = 2_147_483_646; // above every platform's pid_max — never alive

  it('round-trips and consumes once', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    writeLivePtyHeartbeat([{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID }]);
    // pid dropped — autoResumeBootstrap only consumes ovrId/sessionId.
    expect(consumeLivePtyFallback()).toEqual([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);
    expect(consumeLivePtyFallback()).toBeNull();
    expect(fs.existsSync(heartbeatFile())).toBe(false);
  });

  it('returns null when no heartbeat exists', async () => {
    const { consumeLivePtyFallback } = await loadStore();
    expect(consumeLivePtyFallback()).toBeNull();
  });

  it('accepts a heartbeat written before the current boot even if a pid now matches', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    // Machine rebooted 1 min ago; the file is 2h old ⇒ it describes the
    // previous uptime, so every child it names is gone. A pid that happens to
    // match a live process today is pid reuse, not a survivor.
    uptime.seconds = 60;
    writeLivePtyHeartbeat([{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: process.pid }]);
    backdateHeartbeat(2 * 60 * 60 * 1000);
    expect(consumeLivePtyFallback()).toEqual([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);
  });

  it('rejects a same-boot heartbeat whose PTY child is still alive', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    // Server was kill -9'd but its children were orphaned and kept running —
    // resuming would duplicate a live session.
    writeLivePtyHeartbeat([
      { ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID },
      { ovrId: 'ovr-b', sessionId: 'sid-b', pid: process.pid },
    ]);
    expect(consumeLivePtyFallback()).toBeNull();
    // Still consumed — a rejected heartbeat must not be retried next boot.
    expect(fs.existsSync(heartbeatFile())).toBe(false);
  });

  it('accepts a same-boot heartbeat when every recorded pid is dead', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    writeLivePtyHeartbeat([{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID }]);
    expect(consumeLivePtyFallback()).toEqual([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);
  });

  it('rejects a heartbeat older than 24h', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    uptime.seconds = 60;
    writeLivePtyHeartbeat([{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID }]);
    backdateHeartbeat(25 * 60 * 60 * 1000);
    expect(consumeLivePtyFallback()).toBeNull();
  });

  it('returns null for an empty entry list', async () => {
    const { writeLivePtyHeartbeat, consumeLivePtyFallback } = await loadStore();
    // Unlike the clean capture, an empty heartbeat carries no information —
    // "nothing was live" and "never written" are the same answer: resume nothing.
    writeLivePtyHeartbeat([]);
    expect(consumeLivePtyFallback()).toBeNull();
  });

  it('clearLivePtyHeartbeat removes the file and tolerates a missing one', async () => {
    const { writeLivePtyHeartbeat, clearLivePtyHeartbeat } = await loadStore();
    writeLivePtyHeartbeat([{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID }]);
    clearLivePtyHeartbeat();
    expect(fs.existsSync(heartbeatFile())).toBe(false);
    expect(() => clearLivePtyHeartbeat()).not.toThrow();
  });

  it('survives corrupt JSON', async () => {
    const { consumeLivePtyFallback } = await loadStore();
    fs.mkdirSync(path.dirname(heartbeatFile()), { recursive: true });
    fs.writeFileSync(heartbeatFile(), '{ not json');
    expect(consumeLivePtyFallback()).toBeNull();
    expect(fs.existsSync(heartbeatFile())).toBe(false);
  });
});
