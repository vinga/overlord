/**
 * Reading worker replies aloud — Chrome's speechSynthesis, or the Kokoro
 * neural voice running locally (see kokoroVoice.ts).
 *
 * `toSpokenText`, `looksPolish` and `pickEngine` are pure and tested;
 * `ReplyVoice` is the thin browser wrapper.
 */

import { kokoro } from './kokoroVoice';
import type { TtsEngine } from './voiceConfig';

/** Longest text handed to the synthesizer. Some Chrome voices stop silently
 *  after ~15s of speech; this keeps one reading comfortably under that. */
export const MAX_SPOKEN_CHARS = 300;

const MORE = 'More in the panel.';

/**
 * Turns a markdown reply into something worth hearing: code, links, paths and
 * markup are dropped (read aloud they are noise), then the text is cut at a
 * sentence end within `max` characters. Returns '' when nothing speakable is
 * left.
 */
export function toSpokenText(markdown: string, max = MAX_SPOKEN_CHARS, opts: { truncated?: boolean } = {}): string {
  let t = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')            // fenced code, incl. an unclosed tail
    .replace(/`[^`\n]*`/g, ' ')                       // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')            // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // links keep their label
    .replace(/https?:\/\/\S+/g, ' ')                  // bare URLs
    .replace(/(^|\s)(~|\.{1,2})?\/[\w.\-/]+(:\d+)?/g, '$1')  // file paths
    .replace(/^\s*\|.*\|\s*$/gm, ' ')                 // table rows
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')               // heading markers
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')        // list markers
    .replace(/^\s*>\s?/gm, '')                        // quotes
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2') // emphasis
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // `truncated`: the source was already cut upstream (the server keeps 300
  // chars of the last message), so the tail is a fragment even when short.
  if (t.length <= max && !opts.truncated) return t;
  if (t === '') return '';

  // Prefer a sentence end; fall back to a word boundary.
  const head = t.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  // A cut fragment is never worth reading, so any sentence end will do there.
  if (sentenceEnd > 0 && (opts.truncated || sentenceEnd >= max * 0.4)) {
    t = head.slice(0, sentenceEnd + 1);
  } else {
    const space = head.lastIndexOf(' ');
    t = `${head.slice(0, space > 0 ? space : max).replace(/[,;:\s]+$/, '')}…`;
  }
  return `${t} ${MORE}`;
}

/** Best installed voice for a BCP-47 tag: exact match, then same language,
 *  preferring Google's network voices (clearer than the local defaults). */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const want = lang.toLowerCase();
  const base = want.split('-')[0];
  const rank = (v: SpeechSynthesisVoice) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    const langScore = l === want ? 2 : l.split('-')[0] === base ? 1 : 0;
    return langScore === 0 ? -1 : langScore * 2 + (/google/i.test(v.name) ? 1 : 0);
  };
  let best: SpeechSynthesisVoice | null = null;
  let bestRank = -1;
  for (const v of voices) {
    const r = rank(v);
    if (r > bestRank) { best = v; bestRank = r; }
  }
  return best;
}

export function isSpeechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Polish words that are not also common English ones. */
const POLISH_WORDS = new Set([
  'jest', 'nie', 'jak', 'czy', 'dla', 'tego', 'teraz', 'gdzie', 'ale', 'bo', 'mam', 'oraz', 'tylko',
  'przez', 'jeszcze', 'potem', 'kiedy', 'dlaczego', 'wszystko', 'zrobione', 'gotowe', 'plik', 'pliku',
]);

/** Heuristic: Polish diacritics, or at least two Polish-only words. */
export function looksPolish(text: string): boolean {
  if (/[ąćęłńśźżĄĆĘŁŃŚŹŻ]/.test(text)) return true;
  let hits = 0;
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (POLISH_WORDS.has(w) && ++hits >= 2) return true;
  }
  return false;
}

/** How long a reading waits for Kokoro to load before using Chrome's voice. */
export const KOKORO_READY_TIMEOUT_MS = 8000;

/** Kokoro speaks English only, so Polish text — or a Polish language
 *  setting — always goes to Chrome's voice. */
export function pickEngine(engine: TtsEngine | undefined, text: string, lang: string, kokoroUsable: boolean): TtsEngine {
  if (engine !== 'kokoro' || !kokoroUsable) return 'chrome';
  if (lang.toLowerCase().startsWith('pl') || looksPolish(text)) return 'chrome';
  return 'kokoro';
}

export interface SpeakOptions {
  engine?: TtsEngine;
  kokoroVoice?: string;
}

/** One reply at a time across both engines: a new `speak` cuts off the
 *  previous one. */
export class ReplyVoice {
  private active: { stop(): void } | null = null;

  /** `onEnd(completed)`: false when cut off by `stop()` or a newer `speak()`. */
  speak(text: string, lang: string, onEnd: (completed: boolean) => void, opts: SpeakOptions = {}): void {
    if (text.trim() === '') { onEnd(false); return; }
    this.stop();

    let done = false;
    let engineStop: (() => void) | null = null;
    const handle = { stop: () => { engineStop?.(); finish(false); } };
    const finish = (completed: boolean) => {
      if (done) return;
      done = true;
      if (this.active === handle) this.active = null;
      onEnd(completed);
    };
    this.active = handle;

    const chrome = () => {
      if (this.active !== handle) return;
      if (!isSpeechOutputSupported()) { finish(false); return; }
      engineStop = speakChrome(text, lang, () => this.active === handle, finish);
    };

    const client = typeof window !== 'undefined' && typeof Worker !== 'undefined' ? kokoro() : null;
    const usable = client !== null && client.getState().status !== 'error';
    if (pickEngine(opts.engine, text, lang, usable) === 'chrome' || !client) { chrome(); return; }

    void client.whenReady(KOKORO_READY_TIMEOUT_MS).then(ready => {
      if (this.active !== handle) return;
      if (!ready) { chrome(); return; }
      const reading = client.speak(text, opts.kokoroVoice ?? 'af_heart', (completed, failed) => {
        if (failed) chrome(); else finish(completed);
      });
      engineStop = () => reading.stop();
    });
  }

  stop(): void {
    const a = this.active;
    this.active = null;
    a?.stop();
  }

  isSpeaking(): boolean {
    return this.active !== null;
  }
}

/** Reads `text` with Chrome's speechSynthesis. Returns a stop function. */
function speakChrome(text: string, lang: string, isCurrent: () => boolean, finish: (completed: boolean) => void): () => void {
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const voice = pickVoice(synth.getVoices(), lang);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  // cancel() fires onend; by then the reading is no longer current, so it
  // reports completed=false.
  u.onend = () => finish(isCurrent());
  u.onerror = () => finish(false);
  synth.speak(u);
  return () => synth.cancel();
}
