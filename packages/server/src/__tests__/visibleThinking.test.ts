import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, isVisibleThinkingModel, _resetCachesForTest } from '../session/transcriptReader.js';

// Fable / Mythos write two kinds of `thinking` blocks: the real reasoning as an
// empty block carrying only a signature, and a short one-line narration the TUI
// prints inline (not collapsed). The feed must show the latter as text, so the
// reader tags it `visible`. Opus-class thinking text is never visible.

function assistantThinking(model: string, thinking: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      usage: { input_tokens: 10 },
      content: [{ type: 'thinking', thinking, signature: 'CAQSzgkKEQgS…' }],
    },
  });
}

describe('visible thinking narration', () => {
  let tmpDir: string;
  let fp: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-visible-thinking-'));
    fp = path.join(tmpDir, 'session.jsonl');
    _resetCachesForTest();
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('recognises the Fable / Mythos model ids only', () => {
    expect(isVisibleThinkingModel('claude-fable-5-1')).toBe(true);
    expect(isVisibleThinkingModel('claude-mythos-5-1')).toBe(true);
    expect(isVisibleThinkingModel('claude-opus-5')).toBe(false);
    expect(isVisibleThinkingModel('claude-haiku-4-5-20251001')).toBe(false);
    expect(isVisibleThinkingModel(undefined)).toBe(false);
  });

  it('tags a Fable narration block as visible and drops the empty reasoning block', () => {
    fs.writeFileSync(fp, [
      assistantThinking('claude-fable-5-1', '', '2026-09-23T20:38:20.000Z'),
      assistantThinking('claude-fable-5-1', 'Test zwrócił pusty string, więc sprawdzam renderer.\n\n', '2026-09-23T20:38:25.000Z'),
    ].join('\n') + '\n');
    const feed = readTranscriptState(fp).activityFeed ?? [];
    const thinking = feed.filter(i => i.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ visible: true, content: 'Test zwrócił pusty string, więc sprawdzam renderer.\n\n' });
  });

  it('leaves Opus thinking text collapsible (no visible flag)', () => {
    fs.writeFileSync(fp, assistantThinking('claude-opus-5', 'Long private reasoning…', '2026-09-23T20:38:25.000Z') + '\n');
    const thinking = (readTranscriptState(fp).activityFeed ?? []).filter(i => i.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].visible).toBeUndefined();
  });
});
