import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ingestPushed,
  syncSession,
  getProgressCards,
  takeEndedPushCards,
  _resetProgressStoreForTest,
} from '../session/progressStore.js';
import { flushProgressNotifications, completionText, notifyEnabledFor, _resetProgressNotifyForTest } from '../session/progressNotify.js';
import { withManagedBlock, syncCodexAgentsMd, writeInstructions, codexAgentsPath, DEFAULT_INSTRUCTIONS } from '../session/agentInstructions.js';
import type { Session } from '../types.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-push-home-'));
  vi.stubEnv('HOME', home);
  _resetProgressStoreForTest();
  _resetProgressNotifyForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const SID = 'codex-sess';
const line = (id: string, step: number, flag = '') =>
  `::progress id=${id} label="${id} deploy" step=${step}/3 state=rolling${flag ? ` ${flag}` : ''}:: step ${step}`;

describe('pushed progress cards', () => {
  it('builds a multi-row card and ends it when every row is final', () => {
    const t0 = 1_000_000;
    ingestPushed(SID, 'w1', line('dev', 1), t0);
    ingestPushed(SID, 'w1', line('eu', 1), t0 + 1);
    ingestPushed(SID, 'w1', line('dev', 3, 'done'), t0 + 2);
    let [card] = getProgressCards(SID);
    expect(card).toMatchObject({ toolUseId: 'push:w1', source: 'push', status: 'running' });
    expect(card.rows.map(r => r.id)).toEqual(['dev', 'eu']);

    ingestPushed(SID, 'w1', line('eu', 3, 'done'), t0 + 3);
    [card] = getProgressCards(SID);
    expect(card.status).toBe('done');
    expect(takeEndedPushCards()).toHaveLength(1);
    // late lines after the end are ignored
    expect(ingestPushed(SID, 'w1', line('eu', 3), t0 + 4)).toBe(false);
  });

  it('a failing row fails the card', () => {
    ingestPushed(SID, 'w2', line('dev', 2, 'fail'));
    expect(getProgressCards(SID)[0].status).toBe('failed');
  });

  it('goes stale (stopped) when lines stop arriving', () => {
    const t0 = 2_000_000;
    ingestPushed(SID, 'w3', line('dev', 1), t0);
    ingestPushed(SID, 'w3', line('dev', 2), t0 + 10_000);
    expect(syncSession(SID, undefined, undefined, t0 + 60_000)).toBe(false);
    expect(syncSession(SID, undefined, undefined, t0 + 10_000 + 121_000)).toBe(true);
    expect(getProgressCards(SID)[0].status).toBe('stopped');
  });

  it('survives a restart as a persisted card', () => {
    ingestPushed(SID, 'w4', line('dev', 3, 'done'));
    _resetProgressStoreForTest();
    expect(getProgressCards(SID)[0]).toMatchObject({ toolUseId: 'push:w4', source: 'push', status: 'done' });
  });
});

describe('completion ping', () => {
  const session = (over: Partial<Session> = {}) => ({ sessionId: SID, state: 'waiting', provider: 'codex', ...over }) as Session;

  it('is on for codex, off for claude by default, and env-overridable', () => {
    expect(notifyEnabledFor(session(), undefined)).toBe(true);
    expect(notifyEnabledFor(session({ provider: 'claude' }), undefined)).toBe(false);
    expect(notifyEnabledFor(session({ provider: 'claude' }), '1')).toBe(true);
    expect(notifyEnabledFor(session(), '0')).toBe(false);
  });

  it('waits for an idle session, then injects once', () => {
    vi.stubEnv('OVERLORD_PROGRESS_NOTIFY', '');
    ingestPushed(SID, 'w5', line('dev', 3, 'done'));
    const sent: string[] = [];
    let s = session({ state: 'working' });
    const deps = { getSession: () => s, inject: (_: Session, text: string) => { sent.push(text); return true; } };
    flushProgressNotifications(deps);
    expect(sent).toHaveLength(0);
    s = session({ state: 'waiting' });
    flushProgressNotifications(deps);
    flushProgressNotifications(deps);
    expect(sent).toEqual(['[ovr-watch] dev deploy: done — step 3']);
  });

  it('summarizes multi-row cards', () => {
    // Watchers sharing a --watch-id all report in round 1, so every row exists
    // before the first one finishes; the card ends when all rows are final.
    ingestPushed(SID, 'w6', line('dev', 1));
    ingestPushed(SID, 'w6', line('eu', 1));
    ingestPushed(SID, 'w6', line('dev', 3, 'done'));
    ingestPushed(SID, 'w6', line('eu', 2, 'fail'));
    const [card] = getProgressCards(SID);
    expect(completionText(card)).toBe('[ovr-watch] dev deploy: FAILED — dev deploy done, eu deploy fail');
  });
});

describe('agent instructions', () => {
  it('appends a managed block and replaces only that block later', () => {
    const first = withManagedBlock('# My rules\n\nkeep me\n', 'v1');
    expect(first).toContain('keep me');
    expect(first).toContain('v1');
    const second = withManagedBlock(`${first}\nafter\n`, 'v2');
    expect(second).toContain('keep me');
    expect(second).toContain('after');
    expect(second).toContain('v2');
    expect(second).not.toContain('v1');
  });

  it('syncs ~/.codex/AGENTS.md only when codex is installed', () => {
    expect(syncCodexAgentsMd()).toBe('no-codex');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(codexAgentsPath(), 'user text\n');
    expect(syncCodexAgentsMd()).toBe('written');
    expect(fs.readFileSync(codexAgentsPath(), 'utf-8')).toContain(DEFAULT_INSTRUCTIONS.split('\n')[0]);
    expect(syncCodexAgentsMd()).toBe('unchanged');
    writeInstructions('custom rule');
    expect(syncCodexAgentsMd()).toBe('written');
    const text = fs.readFileSync(codexAgentsPath(), 'utf-8');
    expect(text.startsWith('user text')).toBe(true);
    expect(text).toContain('custom rule');
  });
});
