import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A codex sid can also own a stray `~/.claude/projects/<slug>/<sid>.jsonl`
// (hard link left by a shadow restore). The reader picks its parser by path,
// so resolving to that file parses a codex rollout as an empty Claude feed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-codex-path-'));
const cwd = '/repo/studio-backend';
const sid = 'codex-1790769391217-k6za5l';
const rollout = path.join(home, '.codex', 'sessions', '2026', '09', '30', 'rollout-x.jsonl');
const stray = path.join(home, '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'), `${sid}.jsonl`);

let resolveTranscriptPath: typeof import('../session/stateManager.js').resolveTranscriptPath;

beforeAll(async () => {
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, '{"type":"session_meta","payload":{}}\n');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.linkSync(rollout, stray);
  ({ resolveTranscriptPath } = await import('../session/stateManager.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveTranscriptPath for codex sessions', () => {
  it('keeps the linked rollout over a same-named file in ~/.claude/projects', () => {
    expect(resolveTranscriptPath({ cwd, sessionId: sid, transcriptPath: rollout, provider: 'codex' })).toBe(rollout);
  });

  it('still lets a claude session prefer its canonical transcript', () => {
    expect(resolveTranscriptPath({ cwd, sessionId: sid, transcriptPath: rollout, provider: 'claude' })).toBe(stray);
  });
});

describe('codex rollout read from a non-.codex path', () => {
  it('parses an archive copy of a rollout as codex, not as an empty claude feed', async () => {
    const { readTranscriptState } = await import('../session/transcriptReader.js');
    const copy = path.join(home, 'archive', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, [
      JSON.stringify({ timestamp: '2026-09-30T11:58:02.621Z', type: 'session_meta', payload: { id: 'x', cwd } }),
      JSON.stringify({ timestamp: '2026-09-30T11:58:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello from codex' }] } }),
    ].join('\n') + '\n');
    const feed = readTranscriptState(copy).activityFeed ?? [];
    expect(feed.map(i => i.content)).toContain('hello from codex');
  });
});
