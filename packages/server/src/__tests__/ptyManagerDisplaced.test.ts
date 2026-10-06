import { describe, it, expect, vi } from 'vitest';

type Fake = { pid: number; data?: (d: string) => void; exit?: (e: { exitCode: number }) => void };
const fakes: Fake[] = [];
vi.mock('node-pty', () => ({
  spawn: () => {
    const f: Fake = { pid: 1000 + fakes.length };
    fakes.push(f);
    return {
      pid: f.pid,
      onData: (cb: (d: string) => void) => { f.data = cb; },
      onExit: (cb: (e: { exitCode: number }) => void) => { f.exit = cb; },
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    };
  },
}));

const { PtyManager } = await import('../pty/ptyManager.js');
await new Promise(r => setTimeout(r, 0)); // let the dynamic node-pty import settle

describe('PtyManager: a spawn displaced by a newer one under the same id', () => {
  it('neither unlinks the live PTY on exit nor paints into its output', () => {
    const mgr = new PtyManager();
    const output: string[] = [];
    const exits: string[] = [];
    mgr.on('output', (_id: string, d: string) => output.push(d));
    mgr.on('exit', (id: string) => exits.push(id));

    mgr.spawn('codex-1', '/repo', 220, 50, [], 'codex');
    mgr.spawn('codex-1', '/repo', 80, 24, [], 'codex');
    const [old, live] = fakes.slice(-2);

    old.data!('stale frame');
    live.data!('live frame');
    expect(output).toEqual(['live frame']);

    old.exit!({ exitCode: 0 });
    expect(mgr.has('codex-1')).toBe(true);
    expect(mgr.getPid('codex-1')).toBe(live.pid);
    expect(exits).toEqual([]);

    live.exit!({ exitCode: 0 });
    expect(mgr.has('codex-1')).toBe(false);
    expect(exits).toEqual(['codex-1']);
  });
});
