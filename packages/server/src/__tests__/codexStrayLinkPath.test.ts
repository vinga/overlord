import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A codex record whose *stored* path is the stray ~/.claude/projects hard link
// must still resolve to the rollout — found by the codex session id.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-codex-stray-'));
const cwd = '/repo/tl';
const sid = 'codex-1790604251500-t0s9th';
const codexId = '01a0e855-9d96-70a3-938a-8d7b3c6184db';
const rollout = path.join(home, '.codex', 'sessions', '2026', '09', '28', `rollout-2026-09-28T16-05-20-${codexId}.jsonl`);
const stray = path.join(home, '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'), `${sid}.jsonl`);

let resolveTranscriptPath: typeof import('../session/stateManager.js').resolveTranscriptPath;

beforeAll(async () => {
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd } })}\n`);
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.linkSync(rollout, stray);
  ({ resolveTranscriptPath } = await import('../session/stateManager.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveTranscriptPath with a stray stored path', () => {
  it('replaces a stored ~/.claude/projects link with the codex rollout', () => {
    expect(resolveTranscriptPath({
      cwd, sessionId: sid, transcriptPath: stray, provider: 'codex', providerSessionId: codexId,
    })).toBe(rollout);
  });
});
