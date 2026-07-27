import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-shutdown-'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
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
