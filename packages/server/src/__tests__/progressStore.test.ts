import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProgressLine, cleanOutputLine, mergeRow } from '../session/progressParser.js';
import {
  syncSession,
  getProgressCards,
  getProgressHistory,
  _resetProgressStoreForTest,
} from '../session/progressStore.js';
import type { BackgroundTask } from '../types.js';

describe('parseProgressLine', () => {
  it('parses every attribute', () => {
    const row = parseProgressLine('::progress id=dev label="Dev \\"eu\\" deploy" step=3/25 state=behind pct=12:: running=52b958d', 1);
    expect(row).toEqual({
      id: 'dev', label: 'Dev "eu" deploy', step: 3, max: 25, state: 'behind', pct: 12, message: 'running=52b958d', at: 1,
    });
  });

  it('defaults id to main and accepts a bare marker', () => {
    expect(parseProgressLine('::progress:: hello', 1)).toEqual({ id: 'main', message: 'hello', at: 1 });
  });

  it('reads final flags', () => {
    expect(parseProgressLine('::progress id=a state=ok done:: x', 1)?.final).toBe('done');
    expect(parseProgressLine('::progress fail:: x', 1)?.final).toBe('fail');
    expect(parseProgressLine('::progress stopped:: x', 1)?.final).toBe('stopped');
  });

  it('ignores plain output and malformed ids', () => {
    expect(parseProgressLine('round 2 pinned=5342a19', 1)).toBeNull();
    expect(parseProgressLine('::progress id=a/b:: x', 1)?.id).toBe('main');
  });

  it('clamps pct', () => {
    expect(parseProgressLine('::progress pct=250:: x', 1)?.pct).toBe(100);
  });
});

describe('cleanOutputLine', () => {
  it('strips ANSI and keeps the last \\r redraw', () => {
    expect(cleanOutputLine('\x1b[2K⠋ 1/3\r\x1b[2K⠙ 2/3\r')).toBe('⠙ 2/3');
  });
});

describe('mergeRow', () => {
  it('upserts by id, keeps order and a sticky label', () => {
    let rows = mergeRow([], { id: 'dev', label: 'Dev', message: 'a', at: 1 });
    rows = mergeRow(rows, { id: 'eu', message: 'b', at: 2 });
    rows = mergeRow(rows, { id: 'dev', message: 'c', at: 3 });
    expect(rows.map(r => [r.id, r.label, r.message])).toEqual([['dev', 'Dev', 'c'], ['eu', undefined, 'b']]);
  });
});

describe('progressStore', () => {
  let home: string;
  let tmp: string;
  const SID = 'sess-1';

  function task(id: string, file: string): BackgroundTask {
    return { toolUseId: id, taskId: `t-${id}`, description: 'Watch deploy', startedAt: new Date().toISOString(), outputFile: file };
  }
  function append(file: string, text: string) {
    fs.appendFileSync(file, text);
    // mtime granularity: force a visible change between appends
    const t = new Date(Date.now() + Math.random() * 1000);
    fs.utimesSync(file, t, t);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-progress-home-'));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-progress-out-'));
    vi.stubEnv('HOME', home);
    _resetProgressStoreForTest();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads incrementally, tracks rows per id and a raw last line', () => {
    const out = path.join(tmp, 'a.output');
    fs.writeFileSync(out, '');
    const t = task('tu1', out);

    expect(syncSession(SID, [t], undefined)).toBe(true); // card created
    append(out, '::progress id=dev label="Dev" step=1/5 state=behind:: r1\nplain text\n::progress id=eu step=1/5:: e');
    syncSession(SID, [t], undefined);
    let [card] = getProgressCards(SID);
    expect(card.rows.map(r => r.id)).toEqual(['dev']); // 'eu' line is still partial
    expect(card.lastLine).toBe('plain text');

    append(out, 'u1\n');
    syncSession(SID, [t], undefined);
    [card] = getProgressCards(SID);
    expect(card.rows.map(r => [r.id, r.message])).toEqual([['dev', 'r1'], ['eu', 'eu1']]);
    expect(card.lineCount).toBe(3);
    expect(syncSession(SID, [t], undefined)).toBe(false); // no new bytes
  });

  it('ends on leaving the live list, with status from markers or the notification', () => {
    const out = path.join(tmp, 'b.output');
    fs.writeFileSync(out, '');
    const t = task('tu2', out);
    syncSession(SID, [t], undefined);
    append(out, '::progress state=timeout fail:: gave up\n');
    syncSession(SID, [], undefined);
    expect(getProgressCards(SID)[0].status).toBe('failed');

    const out2 = path.join(tmp, 'c.output');
    fs.writeFileSync(out2, '');
    const t2 = task('tu3', out2);
    syncSession(SID, [t2], undefined);
    syncSession(SID, [], { tu3: 'killed' });
    expect(getProgressCards(SID).find(c => c.toolUseId === 'tu3')?.status).toBe('stopped');
  });

  it('flushes an unterminated last line on end', () => {
    const out = path.join(tmp, 'd.output');
    fs.writeFileSync(out, '');
    const t = task('tu4', out);
    syncSession(SID, [t], undefined);
    append(out, '::progress done:: all good');
    syncSession(SID, [], { tu4: 'completed' });
    const [card] = getProgressCards(SID);
    expect(card.status).toBe('done');
    expect(card.rows[0].message).toBe('all good');
  });

  it('persists history and rebuilds cards after a restart', () => {
    const out = path.join(tmp, 'e.output');
    fs.writeFileSync(out, '');
    const t = task('tu5', out);
    syncSession(SID, [t], undefined);
    append(out, '::progress id=dev step=1/2:: one\n::progress id=dev step=2/2 done:: two\n');
    syncSession(SID, [t], undefined);
    syncSession(SID, [], { tu5: 'completed' });

    expect(fs.existsSync(path.join(home, '.claude', 'overlord', 'progress', SID, 'tu5.jsonl'))).toBe(true);
    fs.rmSync(out); // /tmp wiped
    _resetProgressStoreForTest(); // server restart

    const [card] = getProgressCards(SID);
    expect(card.status).toBe('done');
    expect(card.rows[0]).toMatchObject({ id: 'dev', step: 2, max: 2, message: 'two', final: 'done' });
    const hist = getProgressHistory(SID, 'tu5');
    expect(hist.map(e => e.t)).toEqual(['meta', 'line', 'line', 'end']);
  });

  it('resumes a still-running task after restart without re-reading old output', () => {
    const out = path.join(tmp, 'f.output');
    fs.writeFileSync(out, '');
    const t = task('tu6', out);
    syncSession(SID, [t], undefined);
    append(out, '::progress step=1:: a\n');
    syncSession(SID, [t], undefined);
    _resetProgressStoreForTest();

    syncSession(SID, [t], undefined);
    append(out, '::progress step=2:: b\n');
    syncSession(SID, [t], undefined);
    const [card] = getProgressCards(SID);
    expect(card.lineCount).toBe(2);
    expect(card.rows[0].message).toBe('b');
    expect(getProgressHistory(SID, 'tu6').filter(e => e.t === 'line')).toHaveLength(2);
  });

  it('starts over when the output file is truncated', () => {
    const out = path.join(tmp, 'g.output');
    fs.writeFileSync(out, '');
    const t = task('tu7', out);
    syncSession(SID, [t], undefined);
    append(out, 'first long line here\n');
    syncSession(SID, [t], undefined);
    fs.writeFileSync(out, 'new\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(out, later, later);
    syncSession(SID, [t], undefined);
    expect(getProgressCards(SID)[0].lastLine).toBe('new');
  });

  it('does nothing for a session with no tasks and no history', () => {
    expect(syncSession('other', undefined, undefined)).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'overlord', 'progress'))).toBe(false);
  });
});
