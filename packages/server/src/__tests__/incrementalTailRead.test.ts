import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, _resetCachesForTest, _tailReadStatsForTest } from '../session/transcriptReader.js';

// Perf change: readTranscriptState() re-parsed the whole ~2MB tail window on every
// 3s poll for actively-writing transcripts (50–133ms). The append-only fast path
// reads just the new bytes and merges. These tests pin the invariant that MUST hold:
// the incremental result is byte-for-byte identical to a fresh full read of the same
// grown file, and the fast path is genuinely skipped whenever its assumptions break.

const BASE = new Date('2026-06-26T00:00:00Z').getTime();
// Pin mtime 60s in the past so ageSec stays well past every state threshold →
// derived state is deterministic ('waiting') and unaffected by the 2s clock nudges.
const PIN = new Date(BASE - 60_000);

function line(i: number): string {
  if (i % 7 === 0) {
    return JSON.stringify({
      type: 'user',
      timestamp: new Date(BASE - 60_000).toISOString(),
      message: { content: `user turn ${i} about BACKEND-${1000 + i}` },
    });
  }
  if (i % 11 === 0) {
    return JSON.stringify({
      type: 'assistant',
      timestamp: new Date(BASE - 60_000).toISOString(),
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10 + i, cache_read_input_tokens: i },
        content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Edit', input: { file_path: `/f/${i}.ts`, old_string: `a${i}`, new_string: `b${i}` } }],
      },
    });
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(BASE - 60_000).toISOString(),
    message: { model: 'claude-opus-4-8', usage: { input_tokens: i }, content: [{ type: 'text', text: `assistant message number ${i}` }] },
  });
}

function writeLines(fp: string, from: number, to: number): void {
  let s = '';
  for (let i = from; i < to; i++) s += line(i) + '\n';
  fs.writeFileSync(fp, s);
  fs.utimesSync(fp, PIN, PIN);
}

function appendLines(fp: string, from: number, to: number): void {
  let s = '';
  for (let i = from; i < to; i++) s += line(i) + '\n';
  fs.appendFileSync(fp, s);
  fs.utimesSync(fp, PIN, PIN);
}

describe('incremental tail read', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-inctail-'));
    _resetCachesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('incremental result equals a fresh full read of the grown file', () => {
    const fp = path.join(tmpDir, 'sess.jsonl');
    writeLines(fp, 0, 40);
    readTranscriptState(fp); // seed cache (full read)
    expect(_tailReadStatsForTest).toMatchObject({ full: 1, incremental: 0 });

    vi.advanceTimersByTime(2000); // clear the 1s fast-path window
    appendLines(fp, 40, 52);
    const incrementalResult = readTranscriptState(fp);
    expect(_tailReadStatsForTest.incremental).toBe(1); // fast path actually fired

    // Fresh full read of the identical bytes.
    _resetCachesForTest();
    vi.advanceTimersByTime(2000);
    fs.utimesSync(fp, PIN, PIN);
    const fullResult = readTranscriptState(fp);
    expect(_tailReadStatsForTest).toMatchObject({ full: 1, incremental: 0 });

    expect(incrementalResult).toEqual(fullResult);
  });

  it('stays identical across a sequence of appends', () => {
    const fp = path.join(tmpDir, 'seq.jsonl');
    writeLines(fp, 0, 20);
    readTranscriptState(fp);
    let next = 20;
    for (let round = 0; round < 5; round++) {
      vi.advanceTimersByTime(2000);
      appendLines(fp, next, next + 6);
      next += 6;
      const inc = readTranscriptState(fp);

      _resetCachesForTest();
      vi.advanceTimersByTime(2000);
      fs.utimesSync(fp, PIN, PIN);
      const full = readTranscriptState(fp);
      expect(inc).toEqual(full);
      // Re-seed for the next incremental round against the up-to-date file.
      _resetCachesForTest();
      readTranscriptState(fp);
    }
  });

  it('falls back to a full read on truncation and flags transcriptTruncated', () => {
    const fp = path.join(tmpDir, 'trunc.jsonl');
    writeLines(fp, 0, 40);
    readTranscriptState(fp);
    _tailReadStatsForTest.full = 0;
    _tailReadStatsForTest.incremental = 0;

    // Rewrite smaller in place (e.g. /clear inside a --resume'd session).
    vi.advanceTimersByTime(2000);
    writeLines(fp, 0, 5);
    const result = readTranscriptState(fp);

    expect(result.transcriptTruncated).toBe(true);
    expect(_tailReadStatsForTest.incremental).toBe(0); // never incremental on shrink
    expect(_tailReadStatsForTest.full).toBe(1);
  });

  it('falls back to a full read when a torn (newline-less) write is appended', () => {
    const fp = path.join(tmpDir, 'torn.jsonl');
    writeLines(fp, 0, 30);
    readTranscriptState(fp);
    _tailReadStatsForTest.full = 0;
    _tailReadStatsForTest.incremental = 0;

    // Append a partial line with no trailing newline (write in flight).
    vi.advanceTimersByTime(2000);
    fs.appendFileSync(fp, '{"type":"assistant","message":{"content":[{"type":"text","text":"partial');
    fs.utimesSync(fp, PIN, PIN);
    readTranscriptState(fp); // incremental sees no complete new line → full read
    expect(_tailReadStatsForTest.incremental).toBe(0);

    // Complete the line, then append a clean one. Result must equal a fresh full read.
    vi.advanceTimersByTime(2000);
    fs.appendFileSync(fp, ' done"}]}}\n' + line(31) + '\n');
    fs.utimesSync(fp, PIN, PIN);
    const afterComplete = readTranscriptState(fp);

    _resetCachesForTest();
    vi.advanceTimersByTime(2000);
    fs.utimesSync(fp, PIN, PIN);
    const full = readTranscriptState(fp);
    expect(afterComplete).toEqual(full);
  });
});
