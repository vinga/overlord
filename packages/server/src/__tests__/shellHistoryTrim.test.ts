import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// shellHistoryLog resolves its dir from os.homedir() at module load: each test
// gets a fake $HOME and a fresh module, so no real pty log is ever touched.
let HOME: string;
const REAL_HOME = process.env.HOME;

async function load() {
  vi.resetModules();
  const log = await import('../pty/shellHistoryLog.js');
  const routes = await import('../api/shellHistoryRoutes.js');
  return { log, routes };
}

const lines = (n: number, eol = '\n') => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(eol) + eol;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-shell-trim-'));
  process.env.HOME = HOME;
});
afterEach(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('countLines / tailLines', () => {
  it('counts \\n bytes, CRLF once', async () => {
    const { log } = await load();
    expect(log.countLines(Buffer.from(''))).toBe(0);
    expect(log.countLines(Buffer.from('a'))).toBe(0);
    expect(log.countLines(Buffer.from(lines(3)))).toBe(3);
    expect(log.countLines(Buffer.from(lines(3, '\r\n')))).toBe(3);
  });

  it('returns the input when it has ≤ n lines', async () => {
    const { log } = await load();
    const b = Buffer.from(lines(3));
    expect(log.tailLines(b, 3)).toBe(b);
    expect(log.tailLines(b, 10)).toBe(b);
    expect(log.tailLines(Buffer.from(''), 5).length).toBe(0);
  });

  it('keeps the last n complete lines with a trailing newline', async () => {
    const { log } = await load();
    expect(log.tailLines(Buffer.from(lines(5)), 2).toString()).toBe('line 4\nline 5\n');
  });

  it('keeps a trailing partial line (prompt) on top of n lines', async () => {
    const { log } = await load();
    expect(log.tailLines(Buffer.from(lines(5) + '$ '), 2).toString()).toBe('line 4\nline 5\n$ ');
  });

  it('cuts after \\n so CRLF pairs stay intact', async () => {
    const { log } = await load();
    expect(log.tailLines(Buffer.from(lines(4, '\r\n')), 1).toString()).toBe('line 4\r\n');
  });

  it('n = 0 keeps only the partial tail', async () => {
    const { log } = await load();
    expect(log.tailLines(Buffer.from('a\nb\n$ '), 0).toString()).toBe('$ ');
  });
});

describe('trimChunks', () => {
  it('collapses to one chunk in place', async () => {
    const { log } = await load();
    const chunks = [Buffer.from('a\nb\n'), Buffer.from('c\nd'), Buffer.from('\ne\n')];
    const ref = chunks;
    expect(log.trimChunks(chunks, 2)).toBe(2);
    expect(chunks).toBe(ref);
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe('d\ne\n');
  });
});

describe('shell-history routes', () => {
  function deps(sessionType: string) {
    const session = { sessionId: 's1', overlordId: 'ovr1', sessionType };
    return {
      stateManager: {
        getSession: (id: string) => (id === 's1' || id === 'ovr1' ? session : undefined),
        getActiveClaudeByOvr: () => undefined,
      } as never,
      ovrToPty: new Map([['ovr1', 'pty1']]),
      ptyOutputBuffer: new Map<string, Buffer[]>([['pty1', [Buffer.from(lines(800))]]]),
    };
  }

  it('reports and trims both the live buffer and the disk log', async () => {
    const { log, routes } = await load();
    log.appendOutput('ovr1', lines(1200));
    const d = deps('raw');
    expect(routes.shellHistoryLines(d, 's1')).toEqual({ lines: 1200 });

    expect(routes.trimShellHistory(d, 's1', 500)).toEqual({ lines: 500 });
    const disk = fs.readFileSync(path.join(HOME, '.claude', 'overlord', 'pty-logs', 'ovr1.log'), 'utf8');
    expect(disk.startsWith('line 701\n')).toBe(true);
    expect(log.countLines(Buffer.from(disk))).toBe(500);
    const buf = d.ptyOutputBuffer.get('pty1')!;
    expect(buf.length).toBe(1);
    expect(buf[0].toString().startsWith('line 301\n')).toBe(true);
    expect(routes.shellHistoryLines(d, 's1')).toEqual({ lines: 500 });
  });

  it('works with only a disk log (exited / restarted)', async () => {
    const { log, routes } = await load();
    log.appendOutput('ovr1', lines(600));
    const d = deps('raw');
    d.ptyOutputBuffer.clear();
    expect(routes.trimShellHistory(d, 'ovr1', 500)).toEqual({ lines: 500 });
  });

  it('rejects non-shell sessions and unknown ids', async () => {
    const { routes } = await load();
    expect(routes.trimShellHistory(deps('embedded'), 's1', 500)).toEqual({ status: 400, error: 'not a shell session' });
    expect(routes.shellHistoryLines(deps('raw'), 'nope')).toMatchObject({ status: 404 });
  });
});
