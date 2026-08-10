import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildEditContext,
  snippetDiff,
  expandBefore,
  expandAfter,
  fetchFileText,
  clearFileCache,
  contextIsStale,
  MAX_CONTEXT_BYTES,
} from '../editContext.js';

const FILE = [
  'line one',
  'line two',
  'line three',
  'const target = 1;',
  'line five',
  'line six',
  'line seven',
].join('\n');

describe('buildEditContext', () => {
  it('anchors the diff at the real file line when the text matches once', () => {
    const ctx = buildEditContext({
      oldString: 'const target = 0;',
      newString: 'const target = 1;',
      fileText: FILE,
    });
    expect(ctx.reason).toBe('ok');
    expect(ctx.hunks).toHaveLength(1);
    const changed = ctx.hunks[0].rows.filter(r => r.type !== 'ctx');
    expect(changed.map(r => [r.type, r.text])).toEqual([
      ['del', 'const target = 0;'],
      ['add', 'const target = 1;'],
    ]);
    // The added line is line 4 of the file — the whole point of in-file context.
    expect(changed.find(r => r.type === 'add')?.newLine).toBe(4);
    // …and it is surrounded by real neighbours, not by red duplicates.
    const ctxRows = ctx.hunks[0].rows.filter(r => r.type === 'ctx');
    expect(ctxRows.map(r => r.text)).toContain('line three');
    expect(ctxRows.map(r => r.text)).toContain('line five');
  });

  it('falls back when the text is no longer in the file', () => {
    const ctx = buildEditContext({
      oldString: 'gone before',
      newString: 'gone after',
      fileText: FILE,
    });
    expect(ctx.reason).toBe('not-found');
    expect(ctx.fileLines).toBeUndefined();
    expect(ctx.hunks.length).toBeGreaterThan(0);
  });

  it('falls back when the text appears more than once', () => {
    const ctx = buildEditContext({
      oldString: 'x',
      newString: 'line two',
      fileText: 'line two\nmiddle\nline two\n',
    });
    expect(ctx.reason).toBe('ambiguous');
  });

  it('reports truncation without scanning — a cut needle can never match', () => {
    const fileText = { indexOf: vi.fn(() => 0), length: 10, split: () => [] } as unknown as string;
    const ctx = buildEditContext({
      oldString: 'a',
      newString: 'b',
      newStringTruncated: true,
      fileText,
    });
    expect(ctx.reason).toBe('truncated');
    expect((fileText as unknown as { indexOf: ReturnType<typeof vi.fn> }).indexOf).not.toHaveBeenCalled();
  });

  it('falls back when the file could not be read', () => {
    expect(buildEditContext({ oldString: 'a', newString: 'b', fileText: null }).reason).toBe('unavailable');
  });

  it('falls back on an oversized file', () => {
    const huge = 'x'.repeat(MAX_CONTEXT_BYTES + 1);
    expect(buildEditContext({ oldString: 'a', newString: 'b', fileText: huge }).reason).toBe('too-large');
  });

  it('treats a Write as a new file and never needs the file text', () => {
    const ctx = buildEditContext({ oldString: '', newString: 'a\nb', fileText: null });
    expect(ctx.reason).toBe('new-file');
    expect(ctx.hunks[0].rows.every(r => r.type === 'add')).toBe(true);
    expect(ctx.hunks[0].rows.map(r => r.newLine)).toEqual([1, 2]);
  });

  it('keeps unchanged lines as context instead of red+green pairs', () => {
    // The old renderer painted all 3 old lines red and all 3 new lines green.
    const before = 'keep\nCHANGE\nkeep2';
    const after = 'keep\nCHANGED\nkeep2';
    const rows = snippetDiff(before, after);
    const kinds = rows[0].rows.map(r => r.type);
    expect(kinds.filter(k => k === 'ctx')).toHaveLength(2);
    expect(kinds.filter(k => k === 'del')).toHaveLength(1);
    expect(kinds.filter(k => k === 'add')).toHaveLength(1);
  });
});

describe('context expansion', () => {
  const fileLines = FILE.split('\n');

  it('returns the correct absolute lines above and below a hunk', () => {
    const ctx = buildEditContext({
      oldString: 'const target = 0;',
      newString: 'const target = 1;',
      fileText: FILE,
      context: 0,
    });
    const hunk = ctx.hunks[0];
    expect(expandBefore(fileLines, hunk, 2).map(r => [r.newLine, r.text])).toEqual([
      [2, 'line two'],
      [3, 'line three'],
    ]);
    expect(expandAfter(fileLines, hunk, 2).map(r => [r.newLine, r.text])).toEqual([
      [5, 'line five'],
      [6, 'line six'],
    ]);
  });

  it('clamps at the file head and tail', () => {
    const headHunk = { oldStart: 1, newStart: 1, rows: [{ type: 'add' as const, text: 'line one', newLine: 1 }] };
    expect(expandBefore(fileLines, headHunk, 5)).toEqual([]);
    const tailHunk = { oldStart: 7, newStart: 7, rows: [{ type: 'add' as const, text: 'line seven', newLine: 7 }] };
    expect(expandAfter(fileLines, tailHunk, 5)).toEqual([]);
  });
});

describe('contextIsStale', () => {
  const edited = '2026-08-10T10:00:00.000Z';
  const editedMs = Date.parse(edited);

  it('flags a file written well after the edit — context drifted', () => {
    expect(contextIsStale(editedMs + 60_000, edited)).toBe(true);
  });

  it('does not flag the write that IS this edit', () => {
    // The transcript timestamp precedes the actual disk write by a hair.
    expect(contextIsStale(editedMs + 500, edited)).toBe(false);
  });

  it('stays quiet when either side is unknown', () => {
    expect(contextIsStale(undefined, edited)).toBe(false);
    expect(contextIsStale(editedMs + 60_000, undefined)).toBe(false);
    expect(contextIsStale(editedMs + 60_000, 'not-a-date')).toBe(false);
  });
});

describe('fetchFileText cache', () => {
  const original = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    clearFileCache();
    calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ content: 'hello', mtimeMs: 123 }) } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = original; });

  it('issues one request for repeated reads of the same path', async () => {
    expect(await fetchFileText('/a/b.ts')).toEqual({ text: 'hello', mtimeMs: 123 });
    expect(await fetchFileText('/a/b.ts')).toEqual({ text: 'hello', mtimeMs: 123 });
    expect(calls).toBe(1);
  });

  it('caches a failure so a denied path is not re-requested on every expand', async () => {
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return { ok: false, status: 403 } as unknown as Response;
    }) as unknown as typeof fetch;
    expect((await fetchFileText('/secret/.env')).text).toBeNull();
    expect((await fetchFileText('/secret/.env')).text).toBeNull();
    expect(calls).toBe(1);
  });

  it('survives a network rejection', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await fetchFileText('/a/c.ts')).text).toBeNull();
  });
});
