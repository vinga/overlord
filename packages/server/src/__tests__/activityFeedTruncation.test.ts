import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, _resetCachesForTest } from '../session/transcriptReader.js';

// activityFeed used to cut every message at 10,000 chars with no ellipsis and no
// flag: a 10,963-char plan ended mid-word in the DetailPanel chat and the reader
// had no signal that 963 chars were missing. Message text now caps at 32,000 and
// sets contentTruncated when it actually cuts. Tool fields keep the 10k cap.

const BASE = new Date('2026-07-27T12:00:00Z').getTime();
const PIN = new Date(BASE - 60_000);

function assistantText(text: string, tsMs: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10 },
      content: [{ type: 'text', text }],
    },
  });
}

function assistantBlocks(texts: string[], tsMs: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10 },
      content: texts.map((text) => ({ type: 'text', text })),
    },
  });
}

function userMsg(text: string, tsMs: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(tsMs).toISOString(),
    message: { content: text },
  });
}

function editCall(id: string, newString: string, tsMs: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10 },
      content: [{
        type: 'tool_use',
        id,
        name: 'Edit',
        input: { file_path: '/tmp/x.ts', old_string: 'a', new_string: newString },
      }],
    },
  });
}

describe('activityFeed message truncation', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-trunc-'));
    fp = path.join(tmpDir, 'sess.jsonl');
    _resetCachesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(lines: string[]): void {
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    fs.utimesSync(fp, PIN, PIN);
  }

  function messages(role: 'user' | 'assistant') {
    return (readTranscriptState(fp).activityFeed ?? [])
      .filter((i) => i.kind === 'message' && i.role === role);
  }

  it('keeps a 10,963-char assistant message whole (the reported regression)', () => {
    // Exactly the length of the plan message that rendered as
    // "...backgroundTask.test.ts`, m" — cut at the old 10,000 cap.
    const plan = 'p'.repeat(10_963);
    write([assistantText(plan, BASE - 30_000)]);

    const [msg] = messages('assistant');
    expect(msg.content.length).toBe(10_963);
    expect(msg.contentTruncated).toBeUndefined();
  });

  it('cuts an assistant message past 32,000 and flags it', () => {
    write([assistantText('a'.repeat(40_000), BASE - 30_000)]);

    const [msg] = messages('assistant');
    expect(msg.content.length).toBe(32_000);
    expect(msg.contentTruncated).toBe(true);
  });

  it('cuts a user message past 32,000 and flags it', () => {
    write([userMsg('u'.repeat(40_000), BASE - 30_000)]);

    const [msg] = messages('user');
    expect(msg.content.length).toBe(32_000);
    expect(msg.contentTruncated).toBe(true);
  });

  it('joins every text block of a multi-block assistant message', () => {
    write([assistantBlocks(['first block', 'second block'], BASE - 30_000)]);

    const [msg] = messages('assistant');
    expect(msg.content).toBe('first block\n\nsecond block');
    expect(msg.contentTruncated).toBeUndefined();
  });

  it('leaves tool fields on the 10,000 cap', () => {
    write([editCall('tu-1', 'n'.repeat(20_000), BASE - 30_000)]);

    const tools = (readTranscriptState(fp).activityFeed ?? []).filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].newString?.length).toBe(10_000);
  });
});
