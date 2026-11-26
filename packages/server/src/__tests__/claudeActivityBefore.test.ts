import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// "Load older" used to emit bare tool rows (content = tool name, no input,
// no result), so older tool calls could not be clicked open in the feed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-claude-before-'));
const transcript = path.join(home, 'session.jsonl');

let readActivityBefore: typeof import('../session/transcriptReader.js').readActivityBefore;

beforeAll(async () => {
  vi.stubEnv('HOME', home);
  fs.writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-11-17T10:00:00.000Z', type: 'user', message: { content: 'run it' } }),
    JSON.stringify({
      timestamp: '2026-11-17T10:00:01.000Z', type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] },
    }),
    JSON.stringify({
      timestamp: '2026-11-17T10:00:02.000Z', type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] },
    }),
    JSON.stringify({ timestamp: '2026-11-17T15:00:00.000Z', type: 'user', message: { content: 'later' } }),
  ].join('\n') + '\n');
  ({ readActivityBefore } = await import('../session/transcriptReader.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readActivityBefore on a Claude transcript', () => {
  it('keeps tool input and result so the row expands', () => {
    const { items } = readActivityBefore(transcript, '2026-11-17T15:00:00.000Z', 100);
    const tool = items.find(i => i.kind === 'tool');
    expect(tool?.toolName).toBe('Bash');
    expect(tool?.content).not.toBe('Bash');
    expect(JSON.parse(tool!.inputJson!)).toEqual({ command: 'ls -la', description: 'List files' });
    expect(tool?.resultJson).toBe('a.txt\nb.txt');
  });
});
