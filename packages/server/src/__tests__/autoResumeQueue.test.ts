import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

// sessionStore touches $HOME on import; keep tests off the real store.
vi.mock('../session/sessionStore.js', () => ({
  sessionStore: { resolveOverlordId: (sid: string) => sid, getBySessionId: () => undefined },
}));
const transcripts = new Map<string, string>();
vi.mock('../session/transcriptReader.js', () => ({
  resolveResumableSessionId: (sid: string) => (transcripts.has(sid) ? { sessionId: sid, transcriptPath: transcripts.get(sid)! } : null),
}));

import { runResumeQueue, waitForQuiet, orderByRecency } from '../session/autoResumeBootstrap.js';
import type { AutoResumeDeps } from '../session/autoResumeBootstrap.js';

afterEach(() => { vi.useRealTimers(); transcripts.clear(); });

describe('orderByRecency', () => {
  it('puts the newest transcript first and sessions without one last', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'ovr-resume-order-'));
    const mk = (name: string, ageS: number) => {
      const p = join(dir, `${name}.jsonl`);
      fs.writeFileSync(p, '{}');
      const t = (Date.now() - ageS * 1000) / 1000;
      fs.utimesSync(p, t, t);
      transcripts.set(name, p);
    };
    mk('old', 3600);
    mk('new', 10);
    mk('mid', 600);
    const items = ['old', 'none', 'new', 'mid'].map(sessionId => ({ sessionId, cwd: '/repo' }));
    const deps = { stateManager: {} } as unknown as Pick<AutoResumeDeps, 'stateManager'>;
    expect(orderByRecency(items, deps).map(i => i.sessionId)).toEqual(['new', 'mid', 'old', 'none']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runResumeQueue', () => {
  it('never has more than `concurrency` resumes unsettled, and resumes in order', async () => {
    const settlers = new Map<string, () => void>();
    const started: string[] = [];
    let open = 0;
    let peak = 0;
    const run = runResumeQueue(['a', 'b', 'c', 'd', 'e'], {
      concurrency: 2,
      alreadyLive: () => false,
      resume: async (item) => { started.push(item); open++; peak = Math.max(peak, open); return `pty-${item}`; },
      settle: (ptyId) => new Promise<void>(resolve => settlers.set(ptyId, () => { open--; resolve(); })),
    });
    const flush = () => new Promise(r => setTimeout(r, 0));
    await flush();
    expect(started).toEqual(['a', 'b']);
    settlers.get('pty-a')!();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    for (const id of ['pty-b', 'pty-c', 'pty-d', 'pty-e']) { await flush(); settlers.get(id)?.(); }
    await flush();
    settlers.get('pty-e')?.();
    await run;
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(2);
  });

  it('skips an item that already has a live PTY, and a failed resume frees its slot at once', async () => {
    const started: string[] = [];
    await runResumeQueue(['a', 'b', 'c'], {
      concurrency: 1,
      alreadyLive: (item) => item === 'b',
      resume: async (item) => { started.push(item); return item === 'a' ? null : `pty-${item}`; },
      settle: async () => {},
    });
    expect(started).toEqual(['a', 'c']);
  });
});

describe('waitForQuiet', () => {
  const pm = () => new EventEmitter() as unknown as AutoResumeDeps['ptyManager'];

  it('resolves after the PTY has been quiet for quietMs', async () => {
    vi.useFakeTimers();
    const m = pm();
    let done = false;
    void waitForQuiet('p1', m, 1500, 12000).then(() => { done = true; });
    (m as unknown as EventEmitter).emit('output', 'p1', 'x');
    await vi.advanceTimersByTimeAsync(1000);
    (m as unknown as EventEmitter).emit('output', 'p1', 'y'); // resets the quiet timer
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    (m as unknown as EventEmitter).emit('output', 'other', 'z'); // another PTY does not count
    await vi.advanceTimersByTimeAsync(600);
    expect(done).toBe(true);
  });

  it('resolves at the cap even when output never stops', async () => {
    vi.useFakeTimers();
    const m = pm();
    let done = false;
    void waitForQuiet('p1', m, 1500, 5000).then(() => { done = true; });
    // 9 × 500ms = 4.5s of steady output: never quiet, still under the cap.
    for (let i = 0; i < 9; i++) {
      (m as unknown as EventEmitter).emit('output', 'p1', '.');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(done).toBe(true);
  });

  it('resolves when the PTY exits, and removes its listeners', async () => {
    vi.useFakeTimers();
    const m = pm();
    let done = false;
    void waitForQuiet('p1', m, 1500, 12000).then(() => { done = true; });
    (m as unknown as EventEmitter).emit('exit', 'p1', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect((m as unknown as EventEmitter).listenerCount('output')).toBe(0);
    expect((m as unknown as EventEmitter).listenerCount('exit')).toBe(0);
  });
});
