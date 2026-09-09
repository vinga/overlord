import { describe, expect, it } from 'vitest';
import { resolveVoiceTarget, type VoiceWorker } from '../resolveVoiceTarget';
import { VOICE_DEFAULTS } from '../voiceConfig';

const cfg = { ...VOICE_DEFAULTS, enabled: true };

const morion: VoiceWorker = { ovrId: 'ovr-1', name: 'morion', state: 'waiting' };
const atlas: VoiceWorker = { ovrId: 'ovr-2', name: 'atlas', state: 'waiting' };
const workers = [morion, atlas];

function resolve(rest: string, over: Partial<Parameters<typeof resolveVoiceTarget>[0]> = {}) {
  return resolveVoiceTarget({ rest, workers, selectedOvrId: 'ovr-2', cfg, ...over });
}

describe('fallback to the selected worker', () => {
  it('sends an unaddressed prompt to whatever is open in the UI', () => {
    expect(resolve('fix the enter bug')).toMatchObject({
      kind: 'prompt',
      ovrId: 'ovr-2',
      text: 'fix the enter bug',
      queue: false,
    });
  });

  it('refuses when nothing is selected', () => {
    expect(resolve('fix the enter bug', { selectedOvrId: null })).toEqual({
      kind: 'refused',
      reason: 'no worker selected',
    });
  });

  it('refuses when the selection points at a worker that is gone', () => {
    expect(resolve('fix it', { selectedOvrId: 'ovr-404' })).toMatchObject({ kind: 'refused' });
  });

  it('refuses an empty utterance', () => {
    expect(resolve('   ')).toEqual({ kind: 'refused', reason: 'nothing said' });
  });
});

describe('addressing', () => {
  it('a name used as the start word wins over the selection', () => {
    expect(resolve('fix the enter bug', { viaName: 'morion' })).toMatchObject({
      kind: 'prompt',
      ovrId: 'ovr-1',
      text: 'fix the enter bug',
    });
  });

  it('a leading address wins over the selection', () => {
    expect(resolve('morion fix the enter bug')).toMatchObject({
      kind: 'prompt',
      ovrId: 'ovr-1',
      text: 'fix the enter bug',
    });
  });

  it('does NOT strip a prompt word that merely resembles a worker name', () => {
    // "updater" scores 0.87 against "update" — above nameMatchFloor but below
    // the stricter address floor, so the prompt must survive intact.
    const withUpdater = [...workers, { ovrId: 'ovr-3', name: 'updater', state: 'waiting' as const }];
    expect(resolve('update the readme', { workers: withUpdater })).toMatchObject({
      kind: 'prompt',
      ovrId: 'ovr-2',
      text: 'update the readme',
    });
  });

  it('refuses rather than guessing when two workers share a name', () => {
    // Two sessions in one room routinely end up with the same proposedName.
    const twins = [
      { ovrId: 'ovr-1', name: 'morion', state: 'waiting' as const },
      { ovrId: 'ovr-2', name: 'morion', state: 'waiting' as const },
    ];
    const r = resolve('morion fix the bug', { workers: twins, selectedOvrId: 'ovr-1' });
    expect(r).toMatchObject({ kind: 'refused' });
    if (r.kind === 'refused') expect(r.candidates).toEqual(['morion', 'morion']);
  });

  it('treats a badly mangled address as part of the prompt, not a target', () => {
    // "marion" scores 0.83 against "morion" — enough for an explicit
    // `select`, not enough to silently eat the first word of a prompt.
    expect(resolve('marion fix the bug')).toMatchObject({
      kind: 'prompt',
      ovrId: 'ovr-2',
      text: 'marion fix the bug',
    });
  });

  it('ignores a leading address when wakeOnWorkerName is off', () => {
    expect(resolve('morion fix the bug', { cfg: { ...cfg, wakeOnWorkerName: false } })).toMatchObject({
      ovrId: 'ovr-2',
      text: 'morion fix the bug',
    });
  });
});

describe('injection gate', () => {
  it('injects into a waiting worker', () => {
    expect(resolve('fix it')).toMatchObject({ queue: false });
  });

  it('queues for a worker mid-turn rather than interrupting it', () => {
    const busy = [{ ...atlas, state: 'working' as const }];
    expect(resolve('fix it', { workers: busy })).toMatchObject({ kind: 'prompt', queue: true });
  });

  it('queues for a thinking worker too', () => {
    const busy = [{ ...atlas, state: 'thinking' as const }];
    expect(resolve('fix it', { workers: busy })).toMatchObject({ queue: true });
  });

  it('refuses to inject into a closed worker', () => {
    const dead = [{ ...atlas, state: 'closed' as const }];
    expect(resolve('fix it', { workers: dead })).toEqual({
      kind: 'refused',
      reason: 'atlas is closed',
    });
  });
});

describe('commands', () => {
  it('routes a lone bare verb as a command with no target', () => {
    expect(resolve('stop')).toEqual({ kind: 'control', verb: 'stop', text: 'stop' });
  });

  it('keeps a verb with a tail as a prompt', () => {
    expect(resolve('stop using that pattern')).toMatchObject({
      kind: 'prompt',
      text: 'stop using that pattern',
    });
  });

  it('resolves the argument of an arg verb', () => {
    expect(resolve('select morion')).toMatchObject({
      kind: 'control',
      verb: 'select',
      ovrId: 'ovr-1',
    });
  });

  it('resolves a mangled arg-verb name using the configured floor', () => {
    expect(resolve('open marion')).toMatchObject({
      kind: 'control',
      verb: 'open',
      ovrId: 'ovr-1',
    });
  });

  it('refuses an arg verb naming nobody', () => {
    expect(resolve('select zeppelin')).toMatchObject({ kind: 'refused' });
  });

  it('does not apply the injection gate to a command', () => {
    const dead = [{ ...morion, state: 'closed' as const }];
    expect(resolve('select morion', { workers: dead })).toMatchObject({ kind: 'control' });
  });

  it('routes a permission answer as a command', () => {
    expect(resolve('yes')).toMatchObject({ kind: 'control', verb: 'yes' });
  });
});
