/**
 * Client mirror of the server's VoiceInputConfig. The server owns validation
 * (`globalSettingsStore.sanitizeVoice`); this file owns the defaults used when a
 * key is absent, and the precedence rule for a per-session override.
 *
 * Keep the shape and the defaults in sync with
 * `packages/server/src/session/globalSettingsStore.ts`.
 */

export interface VoiceInputConfig {
  enabled: boolean;
  provider: 'webspeech';
  lang: string;
  startWord: string;
  stopWord: string;
  cancelWord: string;
  wakeOnWorkerName: boolean;
  maxUtteranceMs: number;
  nameMatchFloor: number;
}

export const VOICE_DEFAULTS: VoiceInputConfig = {
  enabled: false,
  provider: 'webspeech',
  lang: 'en-US',
  startWord: 'overlord',
  stopWord: 'go',
  cancelWord: 'cancel',
  wakeOnWorkerName: true,
  maxUtteranceMs: 30000,
  nameMatchFloor: 0.72,
};

/** Minimum silence before a trailing stop word counts as a commit. Without it,
 *  "overlord go ahead and fix the injector" would commit on the second word. */
export const MIN_STOP_PAUSE_MS = 300;

/** defaults < global < per-session override. The single precedence rule — both
 *  the agent hook and the settings UI call this, so the effective value is never
 *  computed twice with different ordering. */
export function resolveVoiceConfig(
  global?: Partial<VoiceInputConfig>,
  override?: Partial<VoiceInputConfig>,
): VoiceInputConfig {
  return { ...VOICE_DEFAULTS, ...global, ...override };
}
