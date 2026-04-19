import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, clearTranscriptCache } from '../session/transcriptReader.js';

// Regression: compact_boundary landing within 5s of the final transcript write
// stranded `isCompacting: true` in the fast-path cache. Fix re-evaluates the
// flag from compactCountCache on every fast-path return.

function writeTranscript(fp: string, compactTs: string | null, assistantTs: string): void {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'assistant',
    timestamp: assistantTs,
    message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
  }));
  if (compactTs) {
    lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: compactTs }));
  }
  fs.writeFileSync(fp, lines.join('\n') + '\n');
}

describe('readTranscriptState — isCompacting re-evaluation on fast path', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-compact-'));
    fp = path.join(tmpDir, 'sess.jsonl');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTranscriptCache(fp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isCompacting is true immediately after a compact_boundary write', () => {
    const compactTs = '2026-04-19T13:49:36.588Z';
    const writeTs = '2026-04-19T13:49:36.600Z';
    writeTranscript(fp, compactTs, writeTs);
    // Place "now" 300ms after the compact_boundary → inside the 5s window
    vi.setSystemTime(new Date('2026-04-19T13:49:36.900Z'));

    const r = readTranscriptState(fp);
    expect(r.compactCount).toBe(1);
    expect(r.isCompacting).toBe(true);
  });

  it('fast path clears isCompacting once the 5s window elapses (no new writes)', () => {
    const compactTs = '2026-04-19T13:49:36.588Z';
    writeTranscript(fp, compactTs, '2026-04-19T13:49:36.600Z');

    // First call: within the window → cache holds isCompacting=true
    vi.setSystemTime(new Date('2026-04-19T13:49:36.900Z'));
    const first = readTranscriptState(fp);
    expect(first.isCompacting).toBe(true);

    // Jump 10 seconds forward. File is unchanged → fast path is taken.
    // Pre-fix, result.isCompacting remained `true` forever.
    vi.setSystemTime(new Date('2026-04-19T13:49:46.900Z'));
    const second = readTranscriptState(fp);
    expect(second.isCompacting).toBeUndefined();
  });

  it('fast path keeps isCompacting=true while still inside the 5s window', () => {
    const compactTs = '2026-04-19T13:49:36.588Z';
    writeTranscript(fp, compactTs, '2026-04-19T13:49:36.600Z');

    vi.setSystemTime(new Date('2026-04-19T13:49:36.900Z'));
    const first = readTranscriptState(fp);
    expect(first.isCompacting).toBe(true);

    // 2 seconds later: still within the 5s window
    vi.setSystemTime(new Date('2026-04-19T13:49:38.900Z'));
    const second = readTranscriptState(fp);
    expect(second.isCompacting).toBe(true);
  });

  it('transcripts with no compact_boundary never set isCompacting', () => {
    writeTranscript(fp, null, '2026-04-19T13:49:36.600Z');
    vi.setSystemTime(new Date('2026-04-19T13:49:36.900Z'));
    const r = readTranscriptState(fp);
    expect(r.compactCount).toBeUndefined();
    expect(r.isCompacting).toBeUndefined();
  });
});
