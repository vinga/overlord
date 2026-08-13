import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptState, _resetCachesForTest } from '../session/transcriptReader.js';

describe('Codex Monitor activity', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-codex-monitor-'));
    transcriptPath = path.join(tmpDir, '.codex', 'sessions', 'rollout.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    _resetCachesForTest();
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('surfaces an in-progress Monitor custom tool call', () => {
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: '2026-08-12T14:20:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'Monitor',
        call_id: '13b2298c-f921-4bfb-b3d8-2dd33fb8aaab',
        status: 'in_progress',
        input: { threadName: 'Simple UI for tool management', ovrId: 'ovr-pyyhx5k6' },
      },
    }) + '\n');

    expect(readTranscriptState(transcriptPath).activeMonitors).toEqual([{
      toolUseId: '13b2298c-f921-4bfb-b3d8-2dd33fb8aaab',
      target: 'Simple UI for tool management',
      startedAt: '2026-08-12T14:20:00.000Z',
      until: undefined,
    }]);
  });

  it('clears the monitor when its function output arrives', () => {
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'Monitor', call_id: 'monitor-1', arguments: '{"threadId":"thread-1"}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'monitor-1' } }),
    ].join('\n') + '\n');

    expect(readTranscriptState(transcriptPath).activeMonitors).toBeUndefined();
  });
});
