import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Hands-free voice control. Two configurable words drive the whole flow: the
 *  start word opens capture, the stop word commits. Nothing commits on silence —
 *  the only automatic transition is `maxUtteranceMs`, and it discards. */
export interface VoiceInputConfig {
  /** Master switch. When false nothing is mounted client-side: no `getUserMedia`,
   *  no mic permission prompt, no HUD pill. */
  enabled: boolean;
  /** Speech engine. Only 'webspeech' (Chrome Web Speech API) exists today. */
  provider: 'webspeech';
  /** BCP-47 tag handed to the recognizer, e.g. 'en-US', 'pl-PL'. */
  lang: string;
  /** Opens capture. Nothing leaves the client until this matches. */
  startWord: string;
  /** Commits the utterance. Honoured only utterance-final and only after a
   *  >=300ms pause, so "overlord go ahead and fix it" does not commit on "go". */
  stopWord: string;
  /** Discards the utterance and closes capture. */
  cancelWord: string;
  /** When true a worker's own display name also opens capture, which doubles as
   *  addressing that worker. */
  wakeOnWorkerName: boolean;
  /** Capture is discarded after this long without a stop word. Never commits. */
  maxUtteranceMs: number;
  /** Fuzzy-match confidence floor for spoken worker names. Below it, the target
   *  is refused rather than guessed. */
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

export interface GlobalSettings {
  disableBackgroundLLM: boolean;
  /** When true, sessions with a live PTY at server shutdown are respawned
   *  (`claude --resume`) on the first WS client connection after restart. */
  autoResumeOnRestart: boolean;
  /** When true, the Conversation view pins a one-line header showing the user
   *  message that governs the visible stretch of the feed. Absent in files
   *  written before the setting existed — every read site treats that as true. */
  showStickyUserMessage: boolean;
  /** Root URL of the JIRA instance, e.g. "https://hypatos.atlassian.net".
   *  Used to build chip links: `${jiraBaseUrl}/browse/PROJ-123`. */
  jiraBaseUrl?: string;
  /** Comma-separated allowlist of project key prefixes (e.g. "PROJ,PE,API").
   *  When empty, every regex match is kept (after marker / denylist filters). */
  jiraProjects?: string;
  /** Atlassian account email — paired with jiraApiToken for Basic auth.
   *  When set, the server fetches issue summaries for the keys it shows. */
  jiraEmail?: string;
  /** Atlassian API token. Never returned in /api/settings — clients see "***"
   *  when set, "" when unset. PATCHing "***" leaves the value untouched. */
  jiraApiToken?: string;
  /** Hands-free voice control. Stored as a partial — absent keys read as
   *  VOICE_DEFAULTS. PATCHing it merges key-by-key, so the settings UI can send
   *  one field without clearing the rest. */
  voiceInput?: Partial<VoiceInputConfig>;
}

const DEFAULTS: GlobalSettings = {
  disableBackgroundLLM: false,
  autoResumeOnRestart: false,
  showStickyUserMessage: true,
};

const SETTINGS_DIR = path.join(os.homedir(), '.claude', 'overlord');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

type Listener = (settings: GlobalSettings, prev: GlobalSettings) => void;

class GlobalSettingsStore {
  private cache: GlobalSettings = { ...DEFAULTS };
  private loaded = false;
  private listeners = new Set<Listener>();

  load(): GlobalSettings {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as Partial<GlobalSettings>;
        this.cache = { ...DEFAULTS, ...sanitize(raw) };
      }
    } catch {
      this.cache = { ...DEFAULTS };
    }
    this.loaded = true;
    return this.cache;
  }

  get(): GlobalSettings {
    if (!this.loaded) this.load();
    return this.cache;
  }

  patch(partial: Partial<GlobalSettings>): GlobalSettings {
    if (!this.loaded) this.load();
    const prev = this.cache;
    const clean = sanitize(partial);
    // voiceInput is the one nested field — a shallow spread would replace the
    // whole object and drop every key the caller did not send.
    if (clean.voiceInput) clean.voiceInput = mergeVoice(prev.voiceInput, clean.voiceInput);
    const next: GlobalSettings = { ...prev, ...clean };
    if (shallowEqual(prev, next)) return prev;
    this.cache = next;
    this.persist();
    for (const l of this.listeners) {
      try { l(next, prev); } catch { /* ignore */ }
    }
    return next;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    try {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
      const tmp = `${SETTINGS_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      fs.renameSync(tmp, SETTINGS_PATH);
    } catch (err) {
      console.warn('[settings] failed to persist:', (err as Error).message);
    }
  }
}

function sanitize(input: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const out: Partial<GlobalSettings> = {};
  if (typeof input.disableBackgroundLLM === 'boolean') out.disableBackgroundLLM = input.disableBackgroundLLM;
  if (typeof input.autoResumeOnRestart === 'boolean') out.autoResumeOnRestart = input.autoResumeOnRestart;
  if (typeof input.showStickyUserMessage === 'boolean') out.showStickyUserMessage = input.showStickyUserMessage;
  if (typeof input.jiraBaseUrl === 'string') {
    const trimmed = input.jiraBaseUrl.trim().replace(/\/+$/, '');
    if (trimmed === '' || /^https?:\/\//i.test(trimmed)) {
      out.jiraBaseUrl = trimmed;
    }
    // non-http(s) values silently dropped
  }
  if (typeof input.jiraProjects === 'string') {
    out.jiraProjects = input.jiraProjects.trim();
  }
  if (typeof input.jiraEmail === 'string') {
    out.jiraEmail = input.jiraEmail.trim();
  }
  if (typeof input.jiraApiToken === 'string') {
    out.jiraApiToken = input.jiraApiToken.trim();
  }
  if (input.voiceInput && typeof input.voiceInput === 'object') {
    out.voiceInput = sanitizeVoice(input.voiceInput);
  }
  return out;
}

const VOICE_WORD_KEYS = ['startWord', 'stopWord', 'cancelWord'] as const;
type VoiceWordKey = typeof VOICE_WORD_KEYS[number];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A spoken-word setting is a comma-separated list of alternatives, so a wake
 * word can be written "overlord, overload, over lord" when the speech engine
 * renders it inconsistently. Each alternative is matched case-insensitively
 * against transcript text, so they are stored lowercased and stripped of
 * punctuation the engine never emits. Capped at 8 to keep matching cheap.
 */
function splitWords(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const word = part.trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (word !== '' && word.length <= 40) seen.add(word);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

/** Every alternative a word setting offers, for the distinctness check. */
function wordSet(value: string | undefined, fallback: string): Set<string> {
  return new Set(splitWords(value ?? fallback));
}

/** Field-by-field validation. Anything invalid is dropped, never coerced into a
 *  surprising value — a dropped key falls back to VOICE_DEFAULTS on read. */
function sanitizeVoice(input: Partial<VoiceInputConfig>): Partial<VoiceInputConfig> {
  const out: Partial<VoiceInputConfig> = {};
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  if (input.provider === 'webspeech') out.provider = input.provider;
  if (typeof input.wakeOnWorkerName === 'boolean') out.wakeOnWorkerName = input.wakeOnWorkerName;
  if (typeof input.lang === 'string') {
    const lang = input.lang.trim();
    // Loose BCP-47: primary subtag plus optional region/script subtags.
    if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang)) out.lang = lang;
  }
  for (const key of VOICE_WORD_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string') continue;
    const list = splitWords(raw);
    if (list.length > 0) out[key] = list.join(', ');
  }
  if (typeof input.maxUtteranceMs === 'number' && Number.isFinite(input.maxUtteranceMs)) {
    out.maxUtteranceMs = Math.round(clamp(input.maxUtteranceMs, 5000, 120000));
  }
  if (typeof input.nameMatchFloor === 'number' && Number.isFinite(input.nameMatchFloor)) {
    out.nameMatchFloor = clamp(input.nameMatchFloor, 0.5, 1);
  }
  return out;
}

/** Validation entry point for an untrusted per-session override. Same rules as
 *  the global settings, so an override can never hold a value the global path
 *  would have rejected. */
export function sanitizeVoiceOverride(raw: Record<string, unknown>): Partial<VoiceInputConfig> {
  return sanitizeVoice(raw as Partial<VoiceInputConfig>);
}

/** True when the three spoken words of an effective config are all different. */
function wordsDistinct(candidate: Partial<VoiceInputConfig>): boolean {
  // Each setting may list several alternatives; no alternative may be shared
  // between two of the three roles, or one utterance would mean two things.
  const sets = VOICE_WORD_KEYS.map(k => wordSet(candidate[k], VOICE_DEFAULTS[k]));
  const all = new Set<string>();
  for (const set of sets) {
    for (const w of set) {
      if (all.has(w)) return false;
      all.add(w);
    }
  }
  return true;
}

/**
 * Merges a sanitized patch over the stored partial, key by key, so the settings
 * UI can PATCH a single field without clearing the rest.
 *
 * The three spoken words must stay distinct. The whole patch is tried first, so
 * a caller may move two words at once — swapping the start and stop words, or
 * setting `startWord: 'go'` while moving the stop word elsewhere, both of which
 * are impossible to express one key at a time. Only if the combined result is
 * still ambiguous does it fall back to applying words individually, skipping
 * any that collide, which always leaves a usable config.
 */
export function mergeVoice(
  prev: Partial<VoiceInputConfig> | undefined,
  incoming: Partial<VoiceInputConfig>,
): Partial<VoiceInputConfig> {
  const base: Partial<VoiceInputConfig> = { ...prev };
  for (const [k, v] of Object.entries(incoming)) {
    if (VOICE_WORD_KEYS.includes(k as VoiceWordKey)) continue;
    (base as Record<string, unknown>)[k] = v;
  }

  const whole: Partial<VoiceInputConfig> = { ...base };
  for (const key of VOICE_WORD_KEYS) {
    const word = incoming[key];
    if (word !== undefined) whole[key] = word;
  }
  if (wordsDistinct(whole)) return whole;

  const merged: Partial<VoiceInputConfig> = { ...base };
  for (const key of VOICE_WORD_KEYS) {
    const word = incoming[key];
    if (word === undefined) continue;
    const attempt: Partial<VoiceInputConfig> = { ...merged, [key]: word };
    if (wordsDistinct(attempt)) merged[key] = word;
  }
  return merged;
}

/** Effective config for a session: defaults < global < per-session override. */
export function resolveVoiceConfig(
  global: Partial<VoiceInputConfig> | undefined,
  override?: Partial<VoiceInputConfig>,
): VoiceInputConfig {
  return { ...VOICE_DEFAULTS, ...global, ...override };
}

function shallowEqual(a: GlobalSettings, b: GlobalSettings): boolean {
  return a.disableBackgroundLLM === b.disableBackgroundLLM
    && a.autoResumeOnRestart === b.autoResumeOnRestart
    && a.showStickyUserMessage === b.showStickyUserMessage
    && (a.jiraBaseUrl ?? '') === (b.jiraBaseUrl ?? '')
    && (a.jiraProjects ?? '') === (b.jiraProjects ?? '')
    && (a.jiraEmail ?? '') === (b.jiraEmail ?? '')
    && (a.jiraApiToken ?? '') === (b.jiraApiToken ?? '')
    && voiceEqual(a.voiceInput, b.voiceInput);
}

function voiceEqual(a: Partial<VoiceInputConfig> | undefined, b: Partial<VoiceInputConfig> | undefined): boolean {
  const ra = resolveVoiceConfig(a);
  const rb = resolveVoiceConfig(b);
  return (Object.keys(VOICE_DEFAULTS) as (keyof VoiceInputConfig)[]).every(k => ra[k] === rb[k]);
}

export const globalSettingsStore = new GlobalSettingsStore();
