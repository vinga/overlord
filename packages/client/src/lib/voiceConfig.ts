/**
 * Client mirror of the server's VoiceInputConfig. The server owns validation
 * (`globalSettingsStore.sanitizeVoice`); this file owns the defaults used when a
 * key is absent, and the precedence rule for a per-session override.
 *
 * Keep the shape and the defaults in sync with
 * `packages/server/src/session/globalSettingsStore.ts`.
 */

export type VoiceActivation = 'push' | 'wake';

export interface VoiceInputConfig {
  enabled: boolean;
  provider: 'webspeech';
  activation: VoiceActivation;
  lang: string;
  startWord: string;
  stopWord: string;
  cancelWord: string;
  wakeOnWorkerName: boolean;
  maxUtteranceMs: number;
  nameMatchFloor: number;
  soundCues: boolean;
  speakReplies: boolean;
  listenAfterReply: boolean;
}

export const VOICE_DEFAULTS: VoiceInputConfig = {
  enabled: false,
  provider: 'webspeech',
  activation: 'push',
  lang: 'en-US',
  startWord: 'overlord',
  stopWord: 'go',
  cancelWord: 'cancel',
  wakeOnWorkerName: true,
  maxUtteranceMs: 30000,
  nameMatchFloor: 0.72,
  soundCues: true,
  speakReplies: false,
  listenAfterReply: false,
};

/** Minimum silence before a trailing stop word counts as a commit. Without it,
 *  "overlord go ahead and fix the injector" would commit on the second word. */
export const MIN_STOP_PAUSE_MS = 300;

/** Silence after a trailing stop or cancel word before it takes effect —
 *  "go", then a beat, works like Enter. Applies once the engine has finalized
 *  the word, which it only does after the speaker paused. */
export const STOP_PAUSE_MS = 500;

/** Same, while the stop word is still an interim guess. Chrome often shows
 *  "I go" mid-word ("I got…") and the next words can take over 500 ms to
 *  arrive, which used to send a half-sentence. */
export const INTERIM_STOP_PAUSE_MS = 1500;

/** defaults < global < per-session override. The single precedence rule — both
 *  the agent hook and the settings UI call this, so the effective value is never
 *  computed twice with different ordering. */
export function resolveVoiceConfig(
  global?: Partial<VoiceInputConfig>,
  override?: Partial<VoiceInputConfig>,
): VoiceInputConfig {
  return { ...VOICE_DEFAULTS, ...global, ...override };
}
