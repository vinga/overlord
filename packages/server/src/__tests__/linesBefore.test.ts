import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLinesBefore } from '../session/linesBefore.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-lines-before-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const line = (ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: ts, ...extra });

describe('readLinesBefore', () => {
  it('returns the last `keep` lines before the first line at/after the timestamp', () => {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, ['01', '02', '03', '04', '05'].map(n => line(`2026-01-${n}`)).join('\n') + '\n');
    const r = readLinesBefore(f, '2026-01-04', 2);
    expect(r.lines.map(l => JSON.parse(l).timestamp)).toEqual(['2026-01-02', '2026-01-03']);
    expect(r.total).toBe(3);
  });

  it('keeps lines without a timestamp and unparseable ones; skips blanks', () => {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, `${line('2026-01-01')}\n\n{"type":"summary"}\nnot json\n${line('2026-01-09')}\n`);
    expect(readLinesBefore(f, '2026-01-05', 10).lines).toHaveLength(3);
  });

  it('a nested later timestamp does not end the scan; the top-level one does', () => {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, [
      line('2026-01-01', { attachment: { timestamp: '2026-09-09' } }),
      line('2026-01-02', { message: { content: 'quoted \\"timestamp\\":\\"2099\\"' } }),
      line('2026-01-07'),
    ].join('\n') + '\n');
    expect(readLinesBefore(f, '2026-01-05', 10).total).toBe(2);
  });

  it('works past the chunk size with multi-byte text across chunk edges', () => {
    const f = path.join(dir, 'big.jsonl');
    const body = 'żółw '.repeat(2000);
    const n = 1200;   // ~12 MB: crosses several 4 MB chunks
    const fdw = fs.openSync(f, 'w');
    for (let i = 0; i < n; i++) fs.writeSync(fdw, line(`2026-02-01T00:00:${String(i).padStart(5, '0')}`, { text: body }) + '\n');
    fs.closeSync(fdw);
    const r = readLinesBefore(f, '2026-02-01T00:00:01100', 3);
    expect(r.total).toBe(1100);
    expect(r.lines.map(l => JSON.parse(l).timestamp)).toEqual([
      '2026-02-01T00:00:01097', '2026-02-01T00:00:01098', '2026-02-01T00:00:01099',
    ]);
    expect(JSON.parse(r.lines[2]).text).toBe(body);
    expect(readLinesBefore(f, '2099', 1).total).toBe(n);   // no cut: whole file
  });
});
