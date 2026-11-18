import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-group-'));
  for (const d of ['overlord', 'sessions', 'projects']) fs.mkdirSync(path.join(tmpHome, '.claude', d), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshStateManager() {
  const mod = await import('../session/stateManager.js');
  return new mod.StateManager(() => { /* noop */ });
}

describe('setSessionGroup', () => {
  it('files a session under a group, survives rehydration, null ungroups', async () => {
    const sm = await freshStateManager();
    const snap = (id: string) => sm.getSnapshot().rooms.flatMap(r => r.sessions).find(s => s.sessionId === id);
    sm.addNoteSession('note-40-grp', '/tmp/group-room', 'Grouped');
    expect(sm.setSessionGroup('note-40-grp', 'Infra')).toBe(true);
    expect(snap('note-40-grp')?.group).toBe('Infra');

    sm.remove('note-40-grp');
    sm.rehydrateFromSessionStore('note-40-grp');
    expect(snap('note-40-grp')?.group).toBe('Infra');

    sm.setSessionGroup('note-40-grp', null);
    expect(snap('note-40-grp')?.group).toBeUndefined();
  });

  it('reports an unknown session', async () => {
    const sm = await freshStateManager();
    expect(sm.setSessionGroup('nope', 'X')).toBe(false);
  });
});
