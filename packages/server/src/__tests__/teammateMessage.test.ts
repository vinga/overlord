import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Messages relayed from a Claude Code teammate arrive wrapped in
 * `<teammate-message teammate_id="…">`. The wrapper is transport: it must not
 * become the display name, must not reach the intent prompt, and must not reach
 * the markdown renderer. See parseTeammateMessage / readTeammateId.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-teammate-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function userLine(text: string, sid: string) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    sessionId: sid,
    timestamp: '2026-09-22T09:00:00.000Z',
  });
}

describe('parseTeammateMessage', () => {
  it('extracts teammate_id and trimmed body from a well-formed wrapper', async () => {
    const { parseTeammateMessage } = await import('../session/transcriptReader.js');
    const parsed = parseTeammateMessage(
      '<teammate-message teammate_id="team-lead">\nWatch the dev-01 rollout.\n</teammate-message>',
    );
    expect(parsed).toEqual({ teammateId: 'team-lead', body: 'Watch the dev-01 rollout.' });
  });

  it('tolerates a missing close tag (truncated / streaming entry)', async () => {
    const { parseTeammateMessage } = await import('../session/transcriptReader.js');
    const parsed = parseTeammateMessage('<teammate-message teammate_id="qa-bot">\nRun the suite.');
    expect(parsed).toEqual({ teammateId: 'qa-bot', body: 'Run the suite.' });
  });

  it('keeps markup that appears inside the body', async () => {
    const { parseTeammateMessage } = await import('../session/transcriptReader.js');
    const parsed = parseTeammateMessage(
      '<teammate-message teammate_id="team-lead">Compare <a> and <b>.</teammate-message>',
    );
    expect(parsed?.body).toBe('Compare <a> and <b>.');
  });

  it('returns null for ordinary user text', async () => {
    const { parseTeammateMessage } = await import('../session/transcriptReader.js');
    expect(parseTeammateMessage('make the teammate name nicer')).toBeNull();
    // A mid-text mention is not a relay — the wrapper must anchor at the start.
    expect(parseTeammateMessage('see <teammate-message teammate_id="x">')).toBeNull();
  });
});

describe('readProposedName — teammate relay', () => {
  it('names the session from the body, not the wrapper', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-teammate-name';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      userLine(
        '<teammate-message teammate_id="team-lead">\nCommunicate the dev-01 rollout status once it is live.\n</teammate-message>',
        sid,
      ) + '\n',
    );
    clearSessionCaches(sid);
    const name = readProposedName(sid, transcript);
    expect(name).not.toContain('teammate-message');
    expect(name).toBe('Communicate the dev-01 rollout status once it is l');
  });

  it('leaves a non-teammate first message untouched', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-plain-name';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(transcript, userLine('Refactor the snapshot builder', sid) + '\n');
    clearSessionCaches(sid);
    expect(readProposedName(sid, transcript)).toBe('Refactor the snapshot builder');
  });
});

describe('readTeammateId', () => {
  it('returns the lead id when the first user turn is a relay', async () => {
    const { readTeammateId, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-teammate-id';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'custom-title', customTitle: 'Rollout watch', sessionId: sid }),
        userLine('<teammate-message teammate_id="team-lead">Watch it.</teammate-message>', sid),
        userLine('and report back', sid),
      ].join('\n') + '\n',
    );
    clearSessionCaches(sid);
    expect(readTeammateId(sid, transcript)).toBe('team-lead');
  });

  it('returns undefined for a human-driven session', async () => {
    const { readTeammateId, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-human';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(transcript, userLine('fix the failing test', sid) + '\n');
    clearSessionCaches(sid);
    expect(readTeammateId(sid, transcript)).toBeUndefined();
  });

  it('does not treat a later relay as ownership of a human-started session', async () => {
    const { readTeammateId, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-human-then-relay';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        userLine('fix the failing test', sid),
        userLine('<teammate-message teammate_id="team-lead">status?</teammate-message>', sid),
      ].join('\n') + '\n',
    );
    clearSessionCaches(sid);
    expect(readTeammateId(sid, transcript)).toBeUndefined();
  });
});
