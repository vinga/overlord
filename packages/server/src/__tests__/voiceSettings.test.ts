import { describe, expect, it } from 'vitest';
import {
  VOICE_DEFAULTS,
  mergeVoice,
  resolveVoiceConfig,
  sanitizeVoiceOverride,
  type VoiceInputConfig,
} from '../session/globalSettingsStore.js';

// These are the pure validation/merge helpers — no filesystem, so importing the
// module cannot write to the real ~/.claude/overlord/settings.json.

describe('sanitizeVoiceOverride', () => {
  it('keeps valid values', () => {
    expect(sanitizeVoiceOverride({
      enabled: true, provider: 'webspeech', lang: 'pl-PL',
      startWord: 'overlord', stopWord: 'go', cancelWord: 'cancel',
      wakeOnWorkerName: false, maxUtteranceMs: 30000, nameMatchFloor: 0.8,
    })).toEqual({
      enabled: true, provider: 'webspeech', lang: 'pl-PL',
      startWord: 'overlord', stopWord: 'go', cancelWord: 'cancel',
      wakeOnWorkerName: false, maxUtteranceMs: 30000, nameMatchFloor: 0.8,
    });
  });

  it('normalizes spoken words to lowercase without punctuation', () => {
    expect(sanitizeVoiceOverride({ stopWord: '  Over And Out!  ' }))
      .toEqual({ stopWord: 'over and out' });
  });

  it('drops values of the wrong type rather than coercing them', () => {
    expect(sanitizeVoiceOverride({ enabled: 'yes', maxUtteranceMs: 'lots' })).toEqual({});
  });

  it('rejects an unknown provider', () => {
    expect(sanitizeVoiceOverride({ provider: 'whisper' })).toEqual({});
  });

  it('rejects a malformed language tag', () => {
    expect(sanitizeVoiceOverride({ lang: '!!' })).toEqual({});
    expect(sanitizeVoiceOverride({ lang: 'en-US' })).toEqual({ lang: 'en-US' });
  });

  it('clamps the utterance cap and the name-match floor', () => {
    expect(sanitizeVoiceOverride({ maxUtteranceMs: 999999 })).toEqual({ maxUtteranceMs: 120000 });
    expect(sanitizeVoiceOverride({ maxUtteranceMs: 1 })).toEqual({ maxUtteranceMs: 5000 });
    expect(sanitizeVoiceOverride({ nameMatchFloor: 0.1 })).toEqual({ nameMatchFloor: 0.5 });
    expect(sanitizeVoiceOverride({ nameMatchFloor: 9 })).toEqual({ nameMatchFloor: 1 });
  });

  it('drops an empty or absurdly long word', () => {
    expect(sanitizeVoiceOverride({ startWord: '   ' })).toEqual({});
    expect(sanitizeVoiceOverride({ startWord: 'a'.repeat(41) })).toEqual({});
  });

  it('ignores keys it does not know', () => {
    expect(sanitizeVoiceOverride({ nope: 1, enabled: true })).toEqual({ enabled: true });
  });
});

describe('mergeVoice', () => {
  it('merges key by key so a single-field patch keeps the rest', () => {
    const prev: Partial<VoiceInputConfig> = { lang: 'pl-PL', enabled: true };
    expect(mergeVoice(prev, { maxUtteranceMs: 9000 }))
      .toEqual({ lang: 'pl-PL', enabled: true, maxUtteranceMs: 9000 });
  });

  it('keeps the three spoken words distinct by skipping a colliding one', () => {
    // stopWord would become the startWord — unusable, so the change is dropped.
    expect(mergeVoice({ stopWord: 'go' }, { stopWord: 'overlord' }))
      .toEqual({ stopWord: 'go' });
  });

  it('skips a word that collides with a stored value, not just a default', () => {
    expect(mergeVoice({ startWord: 'jarvis' }, { stopWord: 'jarvis' }))
      .toEqual({ startWord: 'jarvis' });
  });

  it('accepts a word that collides with nothing', () => {
    expect(mergeVoice({}, { stopWord: 'over and out' }))
      .toEqual({ stopWord: 'over and out' });
  });

  it('accepts two words moved together, which one-at-a-time cannot express', () => {
    // Swapping start and stop: each word collides with the other's *current*
    // value, so only judging the combined result can accept this.
    expect(mergeVoice({}, { startWord: 'go', stopWord: 'overlord' }))
      .toEqual({ startWord: 'go', stopWord: 'overlord' });
  });

  it('accepts a full three-word rewrite', () => {
    expect(mergeVoice({}, { startWord: 'jarvis', stopWord: 'execute', cancelWord: 'scratch' }))
      .toEqual({ startWord: 'jarvis', stopWord: 'execute', cancelWord: 'scratch' });
  });

  it('still refuses a patch that cannot be made distinct', () => {
    expect(mergeVoice({}, { startWord: 'same', stopWord: 'same' }))
      .toEqual({ startWord: 'same' });
  });

  it('treats an undefined prev as empty', () => {
    expect(mergeVoice(undefined, { enabled: true })).toEqual({ enabled: true });
  });
});

describe('resolveVoiceConfig', () => {
  it('falls back to defaults for absent keys', () => {
    expect(resolveVoiceConfig(undefined)).toEqual(VOICE_DEFAULTS);
  });

  it('is off by default', () => {
    expect(VOICE_DEFAULTS.enabled).toBe(false);
  });

  it('layers defaults < global < per-session override', () => {
    const r = resolveVoiceConfig({ enabled: true, lang: 'en-US' }, { lang: 'pl-PL' });
    expect(r.enabled).toBe(true);
    expect(r.lang).toBe('pl-PL');
    expect(r.startWord).toBe(VOICE_DEFAULTS.startWord);
  });

  it('lets an override disable voice for one worker', () => {
    expect(resolveVoiceConfig({ enabled: true }, { enabled: false }).enabled).toBe(false);
  });
});
