import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, _cacheSizesForTest, _resetCachesForTest } from '../session/transcriptReader.js';

// Regression: transcriptCache was an unbounded Map. Each entry holds a full
// activityFeed (MBs), and subagent / post-/clear entries are never reached by
// clearSessionCaches — so memory grew without bound. evictTranscriptCache() is
// the LRU + idle-TTL backstop. Cap = 300, idle window = 10 min.

const MAX = 300;

function writeTranscript(fp: string, text: string, ts: string): void {
  fs.writeFileSync(fp, JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { model: 'claude-opus-4-7', content: [{ type: 'text', text }], usage: { input_tokens: 1 } },
  }) + '\n');
}

describe('transcriptCache eviction backstop', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-evict-'));
    _resetCachesForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('caps transcriptCache at MAX entries under churn (LRU)', () => {
    const ts = new Date('2026-06-26T00:00:00Z').toISOString();
    // Read well past the cap; each distinct file would otherwise add an entry.
    for (let i = 0; i < MAX + 80; i++) {
      const fp = path.join(tmpDir, `sess-${i}.jsonl`);
      writeTranscript(fp, `msg ${i}`, ts);
      readTranscriptState(fp);
    }
    expect(_cacheSizesForTest().transcript).toBeLessThanOrEqual(MAX);
  });

  it('evicts entries idle past the 10-minute window', () => {
    vi.setSystemTime(new Date('2026-06-26T00:00:00Z'));
    const oldFp = path.join(tmpDir, 'old.jsonl');
    writeTranscript(oldFp, 'stale', new Date().toISOString());
    readTranscriptState(oldFp);
    expect(_cacheSizesForTest().transcript).toBe(1);

    // Advance past the idle window, then touch a *different* file to trigger evict.
    vi.setSystemTime(new Date('2026-06-26T00:11:00Z'));
    const freshFp = path.join(tmpDir, 'fresh.jsonl');
    writeTranscript(freshFp, 'fresh', new Date().toISOString());
    readTranscriptState(freshFp);

    // Stale entry dropped; only the fresh one remains.
    expect(_cacheSizesForTest().transcript).toBe(1);
  });
});
