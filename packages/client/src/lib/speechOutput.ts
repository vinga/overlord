/**
 * Reading worker replies aloud through the browser's speechSynthesis.
 *
 * `toSpokenText` is pure and tested; `ReplyVoice` is the thin browser wrapper.
 */

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

/** One reply at a time: a new `speak` cuts off the previous one. */
export class ReplyVoice {
  private current: SpeechSynthesisUtterance | null = null;

  /** `onEnd(completed)`: false when cut off by `stop()` or a newer `speak()`. */
  speak(text: string, lang: string, onEnd: (completed: boolean) => void): void {
    if (!isSpeechOutputSupported() || text.trim() === '') { onEnd(false); return; }
    const synth = window.speechSynthesis;
    this.stop();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const voice = pickVoice(synth.getVoices(), lang);
    if (voice) u.voice = voice;
    u.rate = 1.05;

    let done = false;
    const finish = (completed: boolean) => {
      if (done) return;
      done = true;
      if (this.current === u) this.current = null;
      onEnd(completed);
    };
    u.onend = () => finish(this.current === u);
    u.onerror = () => finish(false);
    this.current = u;
    synth.speak(u);
  }

  stop(): void {
    if (!isSpeechOutputSupported()) return;
    const u = this.current;
    this.current = null;
    // cancel() fires the utterance's onend; `current` is already cleared, so it
    // reports completed=false.
    if (u) window.speechSynthesis.cancel();
  }

  isSpeaking(): boolean {
    return this.current !== null;
  }
}
