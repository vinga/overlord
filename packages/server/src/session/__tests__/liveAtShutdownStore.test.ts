import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store resolves its directory from os.homedir() at import time, so HOME
// is stubbed before each fresh import — never touch the real ~/.claude.
let home: string;
let store: typeof import('../liveAtShutdownStore.js');
let heartbeatFile: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-live-pty-'));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  store = await import('../liveAtShutdownStore.js');
  heartbeatFile = path.join(home, '.claude', 'overlord', 'live-pty.json');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22 - 1;
const entries = [{ ovrId: 'ovr-a', sessionId: 'sid-a', pid: DEAD_PID }];

function ageFile(hours: number): void {
  const t = new Date(Date.now() - hours * 3_600_000);
  fs.utimesSync(heartbeatFile, t, t);
}

describe('live-pty heartbeat age', () => {
  it('rejects a heartbeat whose mtime is older than 24h', () => {
    store.writeLivePtyHeartbeat(entries);
    ageFile(37);
    expect(store.consumeLivePtyFallback()).toBeNull();
  });

  it('touch refreshes a stale but unchanged set so it is accepted', () => {
    store.writeLivePtyHeartbeat(entries);
    ageFile(37);
    store.touchLivePtyHeartbeat();
    expect(store.consumeLivePtyFallback()).toEqual([{ ovrId: 'ovr-a', sessionId: 'sid-a' }]);
  });

  it('touch on a missing heartbeat does not create one', () => {
    store.touchLivePtyHeartbeat();
    expect(fs.existsSync(heartbeatFile)).toBe(false);
  });
});
