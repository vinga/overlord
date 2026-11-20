import { describe, expect, it, vi } from 'vitest';
import { MacSpeechProvider, type SpeechEvent } from '../speechProvider';

function setup(connected = true) {
  const target = new EventTarget();
  const sent: object[] = [];
  const send = (m: object) => { sent.push(m); return connected; };
  const provider = new MacSpeechProvider(send, target);
  const results: SpeechEvent[] = [];
  const errors: string[] = [];
  provider.onResult(e => results.push(e));
  provider.onError(m => errors.push(m));
  const push = (detail: object) => target.dispatchEvent(new CustomEvent('overlord:speech', { detail }));
  return { target, sent, provider, results, errors, push };
}

describe('MacSpeechProvider', () => {
  it('subscribes on start and is idempotent for the same language', () => {
    const { sent, provider } = setup();
    provider.start('en-US');
    provider.start('en-US');
    expect(sent).toEqual([{ type: 'speech:start', lang: 'en-US' }]);
    provider.start('pl-PL');
    expect(sent[1]).toEqual({ type: 'speech:start', lang: 'pl-PL' });
  });

  it('relays full transcripts with gaps from arrival times', () => {
    vi.useFakeTimers();
    try {
      const { provider, results, push } = setup();
      provider.start('en-US');
      push({ type: 'speech:result', transcript: 'overlord  say', isFinal: false });
      vi.advanceTimersByTime(450);
      push({ type: 'speech:result', transcript: 'overlord say hi over', isFinal: true });
      expect(results).toEqual([
        { transcript: 'overlord say', isFinal: false, gapMsBefore: 0 },
        { transcript: 'overlord say hi over', isFinal: true, gapMsBefore: 450 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores results while stopped and forwards errors while running', () => {
    const { provider, results, errors, push } = setup();
    push({ type: 'speech:result', transcript: 'stray', isFinal: false });
    expect(results).toEqual([]);
    provider.start('en-US');
    push({ type: 'speech:error', message: 'not-allowed: microphone access denied' });
    expect(errors).toEqual(['not-allowed: microphone access denied']);
  });

  it('sends reset and stop, and re-subscribes after a reconnect', () => {
    const { sent, provider, target } = setup();
    provider.start('en-US');
    provider.reset();
    target.dispatchEvent(new CustomEvent('overlord:ws-open'));
    provider.stop();
    provider.stop();
    target.dispatchEvent(new CustomEvent('overlord:ws-open'));
    expect(sent).toEqual([
      { type: 'speech:start', lang: 'en-US' },
      { type: 'speech:reset' },
      { type: 'speech:start', lang: 'en-US' },
      { type: 'speech:stop' },
    ]);
  });

  it('stops listening after dispose', () => {
    const { provider, results, push } = setup();
    provider.start('en-US');
    provider.dispose();
    push({ type: 'speech:result', transcript: 'late', isFinal: false });
    expect(results).toEqual([]);
  });
});
