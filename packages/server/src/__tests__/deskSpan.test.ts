import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeskSpan } from '../types.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-deskspan-'));
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
  return new mod.StateManager(() => { /* noop */ });
}

function snapSession(sm: Awaited<ReturnType<typeof freshStateManager>>, id: string) {
  return sm.getSnapshot().rooms.flatMap(r => r.sessions).find(s => s.sessionId === id);
}

describe('isDeskSpan', () => {
  it('accepts integer spans within 1–3 × 1–4', () => {
    expect(isDeskSpan({ w: 1, h: 1 })).toBe(true);
    expect(isDeskSpan({ w: 3, h: 4 })).toBe(true);
  });

  it('rejects out-of-range, fractional and malformed spans', () => {
    for (const bad of [{ w: 0, h: 1 }, { w: 4, h: 1 }, { w: 1, h: 5 }, { w: 1.5, h: 1 }, { w: '2', h: 1 }, null, [], {}]) {
      expect(isDeskSpan(bad)).toBe(false);
    }
  });
});

describe('setDeskSpan', () => {
  it('persists the span and surfaces it in the snapshot', async () => {
    const sm = await freshStateManager();
    sm.addNoteSession('note-30-aaa', '/tmp/span-room', 'Big');
    expect(sm.setDeskSpan('note-30-aaa', { w: 2, h: 3 })).toBe(true);
    expect(snapSession(sm, 'note-30-aaa')?.deskSpan).toEqual({ w: 2, h: 3 });

    sm.remove('note-30-aaa');
    sm.rehydrateFromSessionStore('note-30-aaa');
    expect(snapSession(sm, 'note-30-aaa')?.deskSpan).toEqual({ w: 2, h: 3 });
  });

  // Regression: 1×1 used to be stored as unset, which means auto-size — so a
  // card shrunk to 1×1 grew back to its content height on the next tick.
  it('keeps an explicit 1×1; null clears back to auto', async () => {
    const sm = await freshStateManager();
    const { sessionStore } = await import('../session/sessionStore.js');
    sm.addNoteSession('note-31-bbb', '/tmp/span-room', 'Reset');
    sm.setDeskSpan('note-31-bbb', { w: 2, h: 2 });
    sm.setDeskSpan('note-31-bbb', { w: 1, h: 1 });
    expect(sessionStore.getBySessionId('note-31-bbb')?.deskSpan).toEqual({ w: 1, h: 1 });
    expect(snapSession(sm, 'note-31-bbb')?.deskSpan).toEqual({ w: 1, h: 1 });

    sm.setDeskSpan('note-31-bbb', null);
    expect(sessionStore.getBySessionId('note-31-bbb')?.deskSpan).toBeUndefined();
    expect(snapSession(sm, 'note-31-bbb')?.deskSpan).toBeUndefined();
  });

  it('keeps the span through archive and unarchive', async () => {
    const sm = await freshStateManager();
    const { archiveManager } = await import('../archive/archiveManager.js');
    sm.addNoteSession('note-32-ccc', '/tmp/span-room', 'Archived');
    sm.setDeskSpan('note-32-ccc', { w: 3, h: 1 });
    sm.remove('note-32-ccc');
    archiveManager.archive({ sessionId: 'note-32-ccc', cwd: '/tmp/span-room', name: 'Archived', pid: 0, sourceTranscriptPath: null });
    archiveManager.unarchiveForAdoption('note-32-ccc');
    sm.rehydrateFromSessionStore('note-32-ccc');
    expect(snapSession(sm, 'note-32-ccc')?.deskSpan).toEqual({ w: 3, h: 1 });
  });

  it('returns false for an unknown session', async () => {
    const sm = await freshStateManager();
    expect(sm.setDeskSpan('nope', { w: 2, h: 2 })).toBe(false);
  });
});
