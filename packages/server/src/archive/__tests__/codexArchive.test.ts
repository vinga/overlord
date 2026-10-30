import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;
let rollout: string;
const SID = 'codex-1793362131996-9mwdmr';
const ROLLOUT_BODY = '{"type":"session_meta","payload":{"id":"01a18cb7"}}\n{"type":"response_item","payload":{"type":"message","role":"user"}}\n';

beforeEach(() => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-codex-archive-'));
  for (const d of ['overlord', 'sessions', 'projects']) fs.mkdirSync(path.join(tmpHome, '.claude', d), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  rollout = path.join(tmpHome, '.codex', 'sessions', '2026', '10', '30', 'rollout-2026-10-30T13-09-45-01a18cb7.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, ROLLOUT_BODY);
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function setup() {
  const { sessionStore } = await import('../../session/sessionStore.js');
  const { archiveManager } = await import('../archiveManager.js');
  sessionStore.upsertActive({
    overlordId: SID,
    cwd: '/tmp/email-listener',
    startedAt: 1,
    color: '#fff',
    lineage: { currentSessionId: SID, history: [{ sessionId: SID, attachedAt: 1, transcriptPath: rollout, reason: 'initial' }] },
    sessionType: 'embedded',
    provider: 'codex',
  } as Parameters<typeof sessionStore.upsertActive>[0]);
  return { sessionStore, archiveManager };
}

const params = (source: string | null) => ({
  sessionId: SID, cwd: '/tmp/email-listener', name: 'Email review', pid: 0,
  sourceTranscriptPath: source, provider: 'codex',
});

describe('archiving a Codex session', () => {
  it('copies the rollout from the lineage path when the caller found none', async () => {
    const { archiveManager } = await setup();
    const entry = archiveManager.archive(params(null));
    expect(entry).not.toBeNull();
    expect(fs.readFileSync(entry!.transcripts[0].path, 'utf-8')).toBe(ROLLOUT_BODY);
  });

  it('restores the rollout to its original path, byte for byte, not into ~/.claude/projects', async () => {
    const { archiveManager } = await setup();
    archiveManager.archive(params(rollout));
    fs.unlinkSync(rollout);
    expect(archiveManager.restoreTranscript(SID)).toBe(rollout);
    expect(fs.readFileSync(rollout, 'utf-8')).toBe(ROLLOUT_BODY);
    const projects = path.join(tmpHome, '.claude', 'projects');
    expect(fs.readdirSync(projects)).toEqual([]);
  });

  it('unarchives back to an active record', async () => {
    const { archiveManager, sessionStore } = await setup();
    archiveManager.archive(params(rollout));
    expect(archiveManager.unarchiveForAdoption(SID)?.overlordId).toBe(SID);
    expect(sessionStore.getArchivedBySessionId(SID)).toBeUndefined();
  });
});
