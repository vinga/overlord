import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tests for sid-revert detection + name preservation.
 * See specs/sid-revert-and-name-preservation.md.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-revert-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'overlord'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshStateManager() {
  const mod = await import('../session/stateManager.js');
  const sm = new mod.StateManager(() => { /* noop */ });
  return sm;
}

describe('readProposedName — customTitle Strategy 0', () => {
  it('extracts name from transcript customTitle header, stripping ___OVR marker', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-abc-123';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'custom-title', customTitle: 'Fyren___OVR:pty-1776348831063-ph4kfw', sessionId: sid }),
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
      ].join('\n'),
    );
    clearSessionCaches(sid);
    expect(readProposedName(sid, transcript)).toBe('Fyren');
  });

  it('extracts name from transcript customTitle, stripping ___BRG marker', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-bridge';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'custom-title', customTitle: 'Kagami___BRG:77348b72', sessionId: sid }) + '\n',
    );
    clearSessionCaches(sid);
    expect(readProposedName(sid, transcript)).toBe('Kagami');
  });

  it('returns undefined when customTitle is empty after marker strip', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'sid-empty';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'custom-title', customTitle: '___OVR:pty-only', sessionId: sid }) + '\n',
    );
    clearSessionCaches(sid);
    // Empty name after strip → fall through to other strategies (none match here).
    expect(readProposedName(sid, transcript)).toBeUndefined();
  });
});

describe('sid revert detection', () => {
  it('isRevertCandidate: true when candidate is earlier entry in ovrId sessionHistory', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/revert-test';

    // Original session A at T=1000
    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000 });
    // Small delay so sessionHistory timestamps differ
    await new Promise(r => setTimeout(r, 5));
    // Forward /clear: same PID, new sid B
    sm.addOrUpdate({ sessionId: 'sid-B', pid: 100, cwd, startedAt: 1000 });
    sm.transferSessionState('sid-A', 'sid-B');
    // Post-transfer active ovrId lives on sid-B (transferSessionState preserves
    // newSession.overlordId when newSession was just created by addOrUpdate).
    const ovr = sm.getSession('sid-B')?.overlordId!;
    expect(ovr).toBeDefined();
    expect(sm.getActiveClaudeByOvr(ovr)?.sessionId).toBe('sid-B');

    // Revert check: candidate=A (earlier) → true
    expect(sm.isRevertCandidate(ovr, 'sid-A')).toBe(true);
    // Revert check: candidate=B (current) → false
    expect(sm.isRevertCandidate(ovr, 'sid-B')).toBe(false);
    // Revert check: candidate=never-seen → false
    expect(sm.isRevertCandidate(ovr, 'sid-C')).toBe(false);
  });

  it('revertToSid: A→B→A collapses state, removes interim, keeps target as active', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/revert-test';

    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000, name: 'Alice' });
    await new Promise(r => setTimeout(r, 5));
    sm.addOrUpdate({ sessionId: 'sid-B', pid: 100, cwd, startedAt: 1000 });
    sm.transferSessionState('sid-A', 'sid-B');
    const ovr = sm.getSession('sid-B')?.overlordId!;
    // Propagate ovr onto A too (the forward /clear in production, followed by
    // closeOrRemoveReplaced, would normally handle this — but we want to
    // test revert in isolation, so align ovrIds manually).
    const a = sm.getSession('sid-A')!;
    a.overlordId = ovr;
    expect(sm.getSession('sid-A')?.replacedBy).toBe('sid-B');

    // Revert: ovrId rebinds back to A
    sm.revertToSid('sid-B', 'sid-A');

    // B is gone from the live session map
    expect(sm.getSession('sid-B')).toBeUndefined();
    // A is active again, replacedBy cleared
    expect(sm.getActiveClaudeByOvr(ovr)?.sessionId).toBe('sid-A');
    expect(sm.getSession('sid-A')?.replacedBy).toBeUndefined();
    expect(sm.getSession('sid-A')?.overlordId).toBe(ovr);
    // Name preserved on the target
    expect(sm.getSession('sid-A')?.proposedName).toBe('Alice');
  });

  it('revertToSid preserves sessionHistory (both sids remain in the trail)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/revert-test';

    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000 });
    await new Promise(r => setTimeout(r, 5));
    sm.addOrUpdate({ sessionId: 'sid-B', pid: 100, cwd, startedAt: 1000 });
    sm.transferSessionState('sid-A', 'sid-B');
    const ovr = sm.getSession('sid-B')?.overlordId!;
    const a = sm.getSession('sid-A')!;
    a.overlordId = ovr;
    // Propagate merged history back to A too so the revert target has it.
    a.sessionHistory = sm.getSession('sid-B')!.sessionHistory;

    sm.revertToSid('sid-B', 'sid-A');

    const history = sm.getSession('sid-A')?.sessionHistory ?? [];
    const sids = history.map(e => e.sessionId);
    expect(sids).toContain('sid-A');
    expect(sids).toContain('sid-B');
  });

  it('isRevertCandidate: false when candidate is in deletedSessionIds', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/revert-test';
    sm.addOrUpdate({ sessionId: 'sid-A', pid: 100, cwd, startedAt: 1000 });
    await new Promise(r => setTimeout(r, 5));
    sm.addOrUpdate({ sessionId: 'sid-B', pid: 100, cwd, startedAt: 1000 });
    sm.transferSessionState('sid-A', 'sid-B');
    const ovr = sm.getSession('sid-B')?.overlordId!;

    // User explicitly deleted A after the clear
    sm.markDeleted('sid-A');
    expect(sm.isRevertCandidate(ovr, 'sid-A')).toBe(false);
  });

  it('isRevertCandidate: false when history has fewer than 2 entries (no prior sid to revert to)', async () => {
    const sm = await freshStateManager();
    const cwd = '/tmp/revert-test';
    sm.addOrUpdate({ sessionId: 'sid-only', pid: 100, cwd, startedAt: 1000 });
    const ovr = sm.getSession('sid-only')?.overlordId!;
    expect(sm.isRevertCandidate(ovr, 'sid-anything')).toBe(false);
  });
});

describe('saveKnownSessions — backfills proposedName from transcript', () => {
  it('recovers name from customTitle when proposedName is missing', async () => {
    const { readProposedName, clearSessionCaches } = await import('../session/transcriptReader.js');
    const sid = 'a1d78fb2-da27-4a81-8e1e-b3f8ee94324b';
    const transcript = path.join(tmpHome, '.claude', 'projects', `${sid}.jsonl`);
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'custom-title', customTitle: 'Fyren___OVR:pty-xyz', sessionId: sid }) + '\n',
    );
    clearSessionCaches(sid);

    // Direct test of the resolver used by saveKnownSessions.
    const name = readProposedName(sid, transcript);
    expect(name).toBe('Fyren');
  });
});
