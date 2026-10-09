import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMIT_SETTLE_MS, VoiceAgent, type VoiceSnapshot } from '../voiceAgent';
import type { SpeechEvent, SpeechProvider } from '../speechProvider';
import type { VoiceDispatch, VoiceWorker } from '../resolveVoiceTarget';
import { INTERIM_STOP_PAUSE_MS, STOP_PAUSE_MS, VOICE_DEFAULTS, type VoiceInputConfig } from '../voiceConfig';

const PAUSE = 500;

/**
 * Mimics Chrome: the transcript ACCUMULATES across events and every event
 * carries the whole utterance so far, including a restatement of what an
 * earlier interim already said.
 */
class FakeProvider implements SpeechProvider {
  started = 0;
  stopped = 0;
  resets = 0;
  lang = '';
  /** Finalized words so far this utterance. */
  private committed = '';
  private resultCb: ((e: SpeechEvent) => void) | null = null;
  private errorCb: ((m: string) => void) | null = null;

  start(lang: string) { this.started++; this.lang = lang; }
  stop() { this.stopped++; this.committed = ''; }
  onResult(cb: (e: SpeechEvent) => void) { this.resultCb = cb; }
  onError(cb: (m: string) => void) { this.errorCb = cb; }
  reset() { this.resets++; this.committed = ''; }
  dispose() { this.resultCb = null; this.errorCb = null; }

  /** Finalize more words. The emitted transcript is everything so far. */
  say(text: string, gapMsBefore = PAUSE) {
    this.committed = `${this.committed} ${text}`.trim();
    this.resultCb?.({ transcript: this.committed, isFinal: true, gapMsBefore });
  }

  /** An interim guess appended to the finalized text, not yet committed. */
  guess(text: string, gapMsBefore = PAUSE) {
    this.resultCb?.({ transcript: `${this.committed} ${text}`.trim(), isFinal: false, gapMsBefore });
  }

  fail(msg: string) { this.errorCb?.(msg); }
}

function setup(cfgOver: Partial<VoiceInputConfig> = {}, workersOver?: VoiceWorker[]) {
  const provider = new FakeProvider();
  const dispatched: VoiceDispatch[] = [];
  const snapshots: VoiceSnapshot[] = [];
  const workers: VoiceWorker[] = workersOver ?? [
    { ovrId: 'ovr-1', name: 'morion', state: 'waiting' },
    { ovrId: 'ovr-2', name: 'atlas', state: 'waiting' },
  ];
  // Wake-word mode unless a test opts into push-to-talk.
  let cfg: VoiceInputConfig = { ...VOICE_DEFAULTS, enabled: true, activation: 'wake', ...cfgOver };
  let selectedOvrId: string | null = 'ovr-2';

  const agent = new VoiceAgent({
    provider,
    getConfig: () => cfg,
    getContext: () => ({ workers, selectedOvrId }),
    onDispatch: d => dispatched.push(d),
    onChange: s => snapshots.push(s),
    now: () => Date.now(),
  });
  agent.sync();

  return {
    agent, provider, dispatched, snapshots, workers,
    setCfg: (p: Partial<VoiceInputConfig>) => { cfg = { ...cfg, ...p }; },
    setSelected: (id: string | null) => { selectedOvrId = id; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
/** The speaker goes quiet long enough for a trailing stop/cancel word to fire. */
const pause = () => vi.advanceTimersByTime(STOP_PAUSE_MS);
afterEach(() => { vi.useRealTimers(); });

describe('start word', () => {
  it('ignores speech until the start word is heard', () => {
    const { agent, provider } = setup();
    provider.say('so anyway the tests are green');
    expect(agent.snapshot().state).toBe('idle');
  });

  it('opens capture on the start word', () => {
    const { agent, provider } = setup();
    provider.say('overlord fix the enter bug');
    expect(agent.snapshot()).toMatchObject({ state: 'listening', captured: 'fix the enter bug' });
  });

  it('opens capture on a worker name and targets that worker', () => {
    const { agent, provider } = setup();
    provider.say('morion fix the enter bug');
    expect(agent.snapshot().preview).toMatchObject({ ovrId: 'ovr-1' });
  });

  it('does not open capture on a worker name when wakeOnWorkerName is off', () => {
    const { agent, provider } = setup({ wakeOnWorkerName: false });
    provider.say('morion fix the enter bug');
    expect(agent.snapshot().state).toBe('idle');
  });

  it('caps the idle buffer so an unattended mic cannot grow forever', () => {
    const { agent, provider } = setup();
    for (let i = 0; i < 50; i++) provider.say(`word${i}`);
    expect(agent.snapshot().state).toBe('idle');
    // Buffer stayed bounded, and a start word still lands.
    provider.say('overlord fix it');
    expect(agent.snapshot()).toMatchObject({ state: 'listening', captured: 'fix it' });
  });
});

describe('stop word', () => {
  it('dispatches the captured text without the stop word', () => {
    const { provider, dispatched } = setup();
    provider.say('overlord fix the enter bug');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ kind: 'prompt', text: 'fix the enter bug', ovrId: 'ovr-2' });
  });

  it('does NOT dispatch on "go ahead" mid-sentence', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord go ahead and fix the injector');
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('listening');
  });

  it('waits for the pause before sending', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord fix the enter bug');
    provider.say('go');
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().sending).toBe(true);
    vi.advanceTimersByTime(STOP_PAUSE_MS - 1);
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(dispatched[0]).toMatchObject({ text: 'fix the enter bug' });
  });

  it('a word spoken within the pause cancels the send', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord fix it');
    provider.guess('go');
    vi.advanceTimersByTime(STOP_PAUSE_MS - 100);
    provider.guess('go ahead');
    pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot()).toMatchObject({ state: 'listening', sending: false });
  });

  it('commits a whole utterance spoken in one breath', () => {
    // The engine finalizes when the speaker stops, so a final chunk ending in
    // the stop word is a complete instruction. This is how most real dictation
    // arrives; requiring a separate chunk meant it never sent at all.
    const { dispatched, provider } = setup();
    provider.say('overlord fix the enter bug go'); pause();
    expect(dispatched[0]).toMatchObject({ kind: 'prompt', text: 'fix the enter bug' });
  });

  it('does not send when the engine revises the stop word away', () => {
    const { agent, dispatched, provider } = setup();
    provider.guess('overlord fix the enter bug go');
    provider.guess('overlord fix the enter bug goal');
    pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('listening');
  });

  it('still does not commit mid-sentence on a final chunk', () => {
    const { agent, dispatched, provider } = setup();
    provider.say('overlord go ahead and fix the injector');
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('listening');
  });

  it('cancels from a one-breath utterance too', () => {
    const { agent, dispatched, provider } = setup();
    provider.say('overlord fix the enter bug cancel'); pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('returns to idle after dispatching', () => {
    const { agent, provider } = setup();
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(agent.snapshot()).toMatchObject({ state: 'idle', captured: '' });
  });

  it('does not carry text across utterances', () => {
    const { provider, dispatched } = setup();
    provider.say('overlord first thing');
    provider.say('go'); pause();
    provider.say('overlord second thing');
    provider.say('go'); pause();
    expect(dispatched.map(d => (d.kind === 'prompt' ? d.text : ''))).toEqual(['first thing', 'second thing']);
  });

  it('discards a stop word with no payload', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('honours a reconfigured stop word', () => {
    const { provider, dispatched, setCfg } = setup();
    setCfg({ stopWord: 'over and out' });
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(0);
    provider.say('over and out'); pause();
    expect(dispatched[0]).toMatchObject({ text: 'fix it go' });
  });

  it('commits from an interim result after the longer interim pause', () => {
    const { dispatched, provider } = setup();
    provider.say('overlord fix it');
    provider.guess('go'); pause();
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(INTERIM_STOP_PAUSE_MS - STOP_PAUSE_MS);
    expect(dispatched).toHaveLength(1);
  });

  it('does not send when an interim "go" grows into a longer word', () => {
    const { dispatched, provider } = setup();
    provider.say('overlord okay and sometimes I');
    provider.guess('go'); pause();
    provider.guess('got stuck');
    vi.advanceTimersByTime(INTERIM_STOP_PAUSE_MS);
    expect(dispatched).toHaveLength(0);
  });

  it('does not take "ago" for "go"', () => {
    const { dispatched, provider } = setup();
    provider.say('overlord it worked a minute ago'); pause();
    expect(dispatched).toHaveLength(0);
  });
});

describe('restated transcripts (the wake word leaking into the prompt)', () => {
  it('does not send the wake word when the final restates the whole utterance', () => {
    // Chrome emits an interim, then a final that repeats everything including
    // the wake word. Appending that onto already-stripped text used to send
    // "overlord say hi" to the worker.
    const { dispatched, provider } = setup();
    provider.guess('overlord say hi');
    provider.say('overlord say hi go'); pause();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ kind: 'prompt', text: 'say hi' });
  });

  it('keeps the prompt clean across several revisions', () => {
    const { agent, provider } = setup();
    provider.guess('over');
    provider.guess('overlord');
    provider.guess('overlord fix the');
    provider.guess('overlord fix the enter bug');
    expect(agent.snapshot().captured).toBe('fix the enter bug');
  });

  it('clears the engine transcript after a commit so the next utterance is clean', () => {
    const { dispatched, provider } = setup();
    provider.say('overlord first thing go'); pause();
    provider.say('overlord second thing go'); pause();
    expect(dispatched.map(d => (d.kind === 'prompt' ? d.text : ''))).toEqual(['first thing', 'second thing']);
    expect(provider.resets).toBeGreaterThan(0);
  });
});

describe('getting unstuck', () => {
  it('restarts the utterance when the wake word is said again', () => {
    // The reported failure: once capturing, repeating the wake word did nothing
    // and there was no way out but the 30s cap.
    const { agent, provider } = setup();
    provider.say('overlord fix the wrong thing');
    expect(agent.snapshot().captured).toBe('fix the wrong thing');

    provider.say('overlord fix the right thing');
    expect(agent.snapshot().captured).toBe('fix the right thing');
  });

  it('sends only the text after the last wake word', () => {
    const { dispatched, provider } = setup();
    provider.say('overlord fix the wrong thing');
    provider.say('overlord fix the right thing');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ text: 'fix the right thing' });
  });

  it('re-arms the utterance cap on a restart, rather than expiring early', () => {
    const { agent, provider } = setup({ maxUtteranceMs: 10000 });
    provider.say('overlord first attempt');
    vi.advanceTimersByTime(9000);
    provider.say('overlord second attempt');
    vi.advanceTimersByTime(9000);
    expect(agent.snapshot()).toMatchObject({ state: 'listening', captured: 'second attempt' });
  });

  it('does not re-target when a worker name appears mid-prompt', () => {
    // Names open capture from idle, but must not re-wake inside a sentence, or
    // "ask morion about it" would truncate the prompt and change the target.
    const { agent, provider } = setup();
    provider.say('overlord ask morion about the parser');
    expect(agent.snapshot()).toMatchObject({ captured: 'ask morion about the parser' });
    expect(agent.snapshot().preview).toMatchObject({ ovrId: 'ovr-2' });
  });

  it('drops out of capture if the engine revises the wake word away', () => {
    const { agent, provider } = setup();
    provider.guess('overlord fix it');
    expect(agent.snapshot().state).toBe('listening');
    provider.say('never mind then');
    expect(agent.snapshot().state).toBe('idle');
  });
});

describe('cancel', () => {
  it('discards the utterance on the cancel word', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord fix the enter bug');
    provider.say('cancel'); pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot()).toMatchObject({ state: 'idle', captured: '' });
  });

  it('does not treat a prompt starting with cancel as a cancel', () => {
    const { agent, provider } = setup();
    provider.say('overlord cancel the subscription check');
    expect(agent.snapshot().state).toBe('listening');
  });

  it('cancel also waits for the pause, and more words undo it', () => {
    const { agent, provider } = setup();
    provider.say('overlord fix it');
    provider.guess('cancel');
    expect(agent.snapshot().state).toBe('listening');
    provider.guess('cancel the old one');
    pause();
    expect(agent.snapshot().state).toBe('listening');
    provider.say('cancel'); pause();
    expect(agent.snapshot().state).toBe('idle');
  });

  it('discards on an explicit discard() call', () => {
    const { agent, provider, dispatched } = setup();
    provider.say('overlord fix it');
    agent.discard('manual');
    expect(agent.snapshot().state).toBe('idle');
    expect(dispatched).toHaveLength(0);
  });
});

describe('utterance cap', () => {
  it('discards — never dispatches — when the stop word never comes', () => {
    const { agent, provider, dispatched } = setup({ maxUtteranceMs: 30000 });
    provider.say('overlord fix the enter bug');
    vi.advanceTimersByTime(30001);
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot()).toMatchObject({ state: 'idle', captured: '' });
  });

  it('does not fire after a successful dispatch', () => {
    const { provider, dispatched } = setup({ maxUtteranceMs: 30000 });
    provider.say('overlord fix it');
    provider.say('go'); pause();
    vi.advanceTimersByTime(60000);
    expect(dispatched).toHaveLength(1);
  });

  it('restarts the cap for each new utterance', () => {
    const { agent, provider } = setup({ maxUtteranceMs: 10000 });
    provider.say('overlord fix it');
    vi.advanceTimersByTime(9000);
    provider.say('cancel'); pause();
    provider.say('overlord fix it again');
    vi.advanceTimersByTime(9000);
    expect(agent.snapshot().state).toBe('listening');
  });
});

describe('mute and enablement', () => {
  it('stops the recognizer on mute and ignores speech', () => {
    const { agent, provider, dispatched } = setup();
    agent.setMuted(true);
    expect(provider.stopped).toBeGreaterThan(0);
    provider.say('overlord fix it go');
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('off');
  });

  it('resumes on unmute', () => {
    const { agent, provider, dispatched } = setup();
    agent.setMuted(true);
    agent.setMuted(false);
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(1);
  });

  it('never starts the recognizer while disabled', () => {
    const provider = new FakeProvider();
    const agent = new VoiceAgent({
      provider,
      getConfig: () => ({ ...VOICE_DEFAULTS, enabled: false }),
      getContext: () => ({ workers: [], selectedOvrId: null }),
      onDispatch: () => {},
      onChange: () => {},
    });
    agent.sync();
    expect(provider.started).toBe(0);
    expect(agent.snapshot().state).toBe('off');
  });

  it('passes the configured language to the recognizer', () => {
    const { provider } = setup({ lang: 'pl-PL' });
    expect(provider.lang).toBe('pl-PL');
  });
});

describe('targeting through the agent', () => {
  it('falls back to the selected worker', () => {
    const { provider, dispatched } = setup();
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched[0]).toMatchObject({ ovrId: 'ovr-2' });
  });

  it('refuses when nothing is selected', () => {
    const { provider, dispatched, setSelected } = setup();
    setSelected(null);
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched[0]).toMatchObject({ kind: 'refused', reason: 'no worker selected' });
  });

  it('queues instead of injecting into a busy worker', () => {
    const { provider, dispatched } = setup({}, [{ ovrId: 'ovr-2', name: 'atlas', state: 'working' }]);
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched[0]).toMatchObject({ kind: 'prompt', queue: true });
  });

  it('routes a lone bare verb as a command', () => {
    const { provider, dispatched } = setup();
    provider.say('overlord stop');
    provider.say('go'); pause();
    expect(dispatched[0]).toMatchObject({ kind: 'control', verb: 'stop' });
  });
});

describe('errors', () => {
  it('surfaces a provider error and recovers on the next start word', () => {
    const { agent, provider, dispatched } = setup();
    provider.fail('audio-capture');
    expect(agent.snapshot()).toMatchObject({ state: 'error', error: 'audio-capture' });
    provider.say('overlord fix it');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(1);
    expect(agent.snapshot().error).toBeNull();
  });
});

describe('push-to-talk', () => {
  const push = (over: Partial<VoiceInputConfig> = {}) => setup({ activation: 'push', ...over });

  it('keeps the microphone closed until begin()', () => {
    const { agent, provider } = push();
    expect(provider.started).toBe(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('captures everything said, with no start word', () => {
    const { agent, provider } = push();
    agent.begin();
    expect(provider.started).toBe(1);
    provider.say('fix the flaky test');
    expect(agent.snapshot()).toMatchObject({ state: 'listening', captured: 'fix the flaky test', manual: true });
  });

  it('commit() sends after the settle delay and releases the microphone', () => {
    const { agent, provider, dispatched } = push();
    agent.begin();
    provider.say('fix the flaky');
    agent.commit();
    // The engine's last words arrive after the keypress.
    provider.say('test');
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched[0]).toMatchObject({ kind: 'prompt', ovrId: 'ovr-2', text: 'fix the flaky test' });
    expect(agent.snapshot().state).toBe('idle');
    expect(provider.stopped).toBeGreaterThan(0);
  });

  it('commit() with nothing heard sends nothing', () => {
    const { agent, dispatched } = push();
    agent.begin();
    agent.commit();
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('discard() drops the capture', () => {
    const { agent, provider, dispatched } = push();
    agent.begin();
    provider.say('never mind');
    agent.discard();
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('a discard during the settle delay wins over the commit', () => {
    const { agent, provider, dispatched } = push();
    agent.begin();
    provider.say('fix it');
    agent.commit();
    agent.discard();
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched).toHaveLength(0);
  });

  it('the stop word still sends', () => {
    const { agent, provider, dispatched } = push();
    agent.begin();
    provider.say('fix it');
    provider.say('go'); pause();
    expect(dispatched[0]).toMatchObject({ text: 'fix it' });
    expect(agent.snapshot().state).toBe('idle');
  });

  it('ignores speech that arrives after capture closed', () => {
    const { agent, provider, dispatched } = push();
    agent.begin();
    agent.discard();
    provider.say('stray words');
    provider.say('go'); pause();
    expect(dispatched).toHaveLength(0);
    expect(agent.snapshot().state).toBe('idle');
  });

  it('discards at the utterance cap', () => {
    const { agent, provider, dispatched } = push({ maxUtteranceMs: 5000 });
    agent.begin();
    provider.say('fix it');
    vi.advanceTimersByTime(5000);
    expect(agent.snapshot().state).toBe('idle');
    expect(dispatched).toHaveLength(0);
  });

  it('begin() does nothing while muted', () => {
    const { agent, provider } = push();
    agent.setMuted(true);
    expect(agent.begin()).toBe(false);
    expect(provider.started).toBe(0);
  });

  it('an error closes the capture and releases the microphone', () => {
    const { agent, provider } = push();
    agent.begin();
    const stoppedBefore = provider.stopped;
    provider.fail('network');
    expect(agent.snapshot()).toMatchObject({ state: 'error', manual: false });
    expect(provider.stopped).toBeGreaterThan(stoppedBefore);
    // and the next begin() recovers
    expect(agent.begin()).toBe(true);
    expect(agent.snapshot().state).toBe('listening');
  });

  it('begin() in wake mode captures without the start word and keeps listening after', () => {
    const { agent, provider, dispatched } = setup();
    const stoppedBefore = provider.stopped;
    agent.begin();
    provider.say('fix it');
    agent.commit();
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched[0]).toMatchObject({ text: 'fix it' });
    expect(provider.stopped).toBe(stoppedBefore);
    // The start word still works afterwards.
    provider.say('overlord again');
    expect(agent.snapshot().state).toBe('listening');
  });

  it('commit() right after the stop word does not send the word', () => {
    const { agent, provider, dispatched } = setup({ activation: 'push' });
    agent.begin();
    provider.say('fix it go');
    agent.commit();
    vi.advanceTimersByTime(COMMIT_SETTLE_MS);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ text: 'fix it' });
  });

  it('emits sound cues for start, send and cancel', () => {
    const provider = new FakeProvider();
    const cues: string[] = [];
    const agent = new VoiceAgent({
      provider,
      getConfig: () => ({ ...VOICE_DEFAULTS, enabled: true, activation: 'push' }),
      getContext: () => ({ workers: [{ ovrId: 'ovr-2', name: 'atlas', state: 'waiting' }], selectedOvrId: 'ovr-2' }),
      onDispatch: () => {},
      onChange: () => {},
      onCue: c => cues.push(c),
    });
    agent.sync();
    agent.begin();
    provider.say('fix it go'); pause();
    agent.begin();
    agent.discard();
    expect(cues).toEqual(['start', 'send', 'start', 'cancel']);
  });

  it('a refused send sounds like a cancel, not a send', () => {
    const provider = new FakeProvider();
    const cues: string[] = [];
    const agent = new VoiceAgent({
      provider,
      getConfig: () => ({ ...VOICE_DEFAULTS, enabled: true, activation: 'push' }),
      getContext: () => ({ workers: [], selectedOvrId: null }),
      onDispatch: () => {},
      onChange: () => {},
      onCue: c => cues.push(c),
    });
    agent.sync();
    agent.begin();
    provider.say('fix it go'); pause();
    expect(cues).toEqual(['start', 'cancel']);
  });
});
