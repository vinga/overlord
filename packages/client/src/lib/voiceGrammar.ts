/**
 * Pure text matching for hands-free voice control. No DOM, no timers, no
 * recognizer — every rule here is a function of a transcript string.
 *
 * Two words drive the whole flow: the start word opens capture, the stop word
 * commits. Both are matched on a normalized token stream, but every text the
 * caller ends up injecting is sliced out of the *original* string, so the
 * worker receives the user's real casing and punctuation.
 */

import { MIN_STOP_PAUSE_MS } from './voiceConfig';

export interface Token {
  /** Lowercased, punctuation-stripped word. */
  word: string;
  /** Offset of the word in the original string. */
  start: number;
  /** Offset one past the word in the original string. */
  end: number;
}

/** Words plus their spans in the original text. Punctuation is skipped rather
 *  than tokenized, so slicing by span keeps mid-sentence commas intact. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  for (const m of text.matchAll(re)) {
    out.push({
      word: m[0].toLowerCase().replace(/’/g, "'"),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Splits a configured setting into alternative phrases on commas, so a wake
 * word can be written as "overlord, overload, over lord". Any one of them
 * wakes. This is the escape hatch for a rendering too far from the original for
 * fuzzy matching to reach safely — the pill shows what the engine actually
 * returned, and that string can be pasted in here verbatim.
 */
export function phraseList(setting: string): string[] {
  return setting.split(',').map(p => p.trim()).filter(p => p !== '');
}

/** Token words of a configured phrase, e.g. "over and out" → 3 words. */
export function phraseWords(phrase: string): string[] {
  return tokenize(phrase).map(t => t.word);
}

/**
 * How close a heard phrase must be to a wake phrase to count.
 *
 * Speech engines mangle uncommon words in several predictable ways: they split
 * them ("overlord" → "over lord"), wedge a filler word into the seam
 * ("over the lord"), and substitute a common neighbour ("overlord" →
 * "overload"). Requiring an exact token match makes an otherwise finished
 * feature appear completely dead, so wake matching compares the space-stripped
 * run of tokens, skips fillers in the seam, and allows a near miss.
 *
 * Measured scores against "overlord":
 *
 *   overlords 0.900   overload 0.875   overboard 0.778   overlordian 0.755
 *   overlot   0.750   overlooked 0.700 | overlap 0.625   over 0.550
 *   overview  0.500   overall 0.500    overnight 0.444   offer 0.250
 *
 * The floor sits at 0.70, which does admit "overboard" and "overlooked". That
 * is a deliberate trade, not an oversight: a false wake only opens capture — it
 * sends nothing until the stop word, and "cancel" or the utterance cap discards
 * it. A *missed* wake makes the whole feature look broken with no recourse. So
 * the cost is asymmetric, and the threshold leans toward catching.
 *
 * Fuzziness still has a limit: a rendering like "of a lord" shares too little
 * with "overlord" for any safe threshold. That is what the comma-separated
 * alternatives in `startWord` are for — see `phraseList`.
 */
export const WAKE_FUZZY_FLOOR = 0.7;

/** Longest run of heard tokens that may be joined into one wake phrase. */
const MAX_WAKE_TOKENS = 5;

/**
 * Words the engine drops into the seam of a split compound, or that a speaker
 * hesitates with. Skipped when joining tokens, so "over the lord" and
 * "over uh lord" both join to "overlord". Never allowed to *start* a match, so
 * a sentence beginning "the ..." cannot wake anything.
 */
const SEAM_FILLERS: ReadonlySet<string> = new Set(['the', 'a', 'uh', 'um', 'er', 'eh', 'and', 'of']);

/**
 * A token is skippable filler only if the phrase we are matching does not
 * itself contain that word. Without this, the stop phrase "over and out" would
 * have its own "and" skipped and could never match.
 */
function skippableIn(phrase: string): (word: string) => boolean {
  const own = new Set(phraseWords(phrase));
  return (word: string) => SEAM_FILLERS.has(word) && !own.has(word);
}

/**
 * Tries to match `phrase` starting at token `i`, allowing the engine to have
 * split it across several tokens. Returns how many tokens it consumed, or 0.
 */
function matchPhraseAt(tokens: Token[], i: number, phrase: string, floor: number): number {
  const wanted = phraseWords(phrase).join('');
  if (wanted === '') return 0;
  const skippable = skippableIn(phrase);
  if (skippable(tokens[i].word)) return 0;   // a filler cannot open a match
  const limit = Math.min(MAX_WAKE_TOKENS, tokens.length - i);

  let bestLen = 0;
  let bestScore = 0;
  let joined = '';
  for (let k = 1; k <= limit; k++) {
    const word = tokens[i + k - 1].word;
    // Fillers are consumed but contribute no letters, so "over the lord" joins
    // to "overlord" rather than "overthelord".
    if (!skippable(word)) joined += word;
    if (joined === wanted) return k;                 // exact, including "over lord"
    if (joined.length > wanted.length * 1.6) break;  // overshot; longer runs can only be worse
    const score = similarity(joined, wanted);
    if (score >= floor && score > bestScore) { bestScore = score; bestLen = k; }
  }
  return bestLen;
}

/**
 * Whether an entire heard chunk is the phrase, tolerating the same mangling as
 * the wake word. Used for a commit word that arrived on its own.
 */
export function chunkIsPhrase(chunk: string, phrase: string): boolean {
  const tokens = tokenize(chunk);
  if (tokens.length === 0) return false;
  const consumed = matchPhraseAt(tokens, 0, phrase, WAKE_FUZZY_FLOOR);
  return consumed === tokens.length;
}

/**
 * Fuzzy-tolerant match of `phrase` against the *end* of `text`, returning the
 * text with that run removed. The shortest matching run wins, so a mangled stop
 * word is stripped without eating a word of the actual instruction.
 */
export function matchTrailingPhrase(text: string, setting: string): { hit: boolean; stripped: string } {
  const miss = { hit: false, stripped: text.trim() };
  const alternatives = phraseList(setting);
  if (alternatives.length > 1) {
    for (const alt of alternatives) {
      const r = matchTrailingPhrase(text, alt);
      if (r.hit) return r;
    }
    return miss;
  }

  const phrase = alternatives[0] ?? '';
  const tokens = tokenize(text);
  const wanted = phraseWords(phrase).join('');
  if (wanted === '' || tokens.length === 0) return miss;

  const skippable = skippableIn(phrase);
  const maxK = Math.min(MAX_WAKE_TOKENS, tokens.length);
  for (let k = 1; k <= maxK; k++) {
    const start = tokens.length - k;
    if (skippable(tokens[start].word)) continue;   // a filler cannot open a match
    const joined = tokens.slice(start)
      .filter(t => !skippable(t.word))
      .map(t => t.word)
      .join('');
    if (joined === wanted || similarity(joined, wanted) >= WAKE_FUZZY_FLOOR) {
      return { hit: true, stripped: text.slice(0, tokens[start].start).trim() };
    }
  }
  return miss;
}

export interface StartMatch {
  matched: boolean;
  /** Original text after the start phrase, trimmed. */
  rest: string;
  /** Character offset in the original text where `rest` begins. Lets a caller
   *  tell a fresh wake from the one it is already acting on. */
  at: number;
  /** The worker name that opened capture, when a name matched instead of the
   *  configured start word. Doubles as addressing — that worker is the target. */
  viaName?: string;
}

/**
 * Finds the start word (or, when enabled, any worker name) and returns
 * everything after it. Earliest occurrence wins; on a tie the longest phrase
 * wins, so a worker named "overlord bridge" beats the bare start word.
 */
export function matchStart(
  text: string,
  startWord: string,
  workerNames: readonly string[] = [],
  /**
   * 'first' is right when opening capture: whatever was said before the wake
   * word is noise. 'last' is right when capture is already open, because
   * repeating the wake word is how the speaker restarts a sentence they
   * fumbled — the alternative is being stuck until the utterance cap expires.
   */
  prefer: 'first' | 'last' = 'first',
): StartMatch {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { matched: false, rest: '', at: 0 };

  const candidates: Array<{ phrase: string; name?: string }> = [
    ...phraseList(startWord).map(phrase => ({ phrase })),
    ...workerNames.map(n => ({ phrase: n, name: n })),
  ].filter(c => phraseWords(c.phrase).length > 0);

  // At a given position the longest run wins, so a worker named
  // "overlord bridge" beats the bare start word.
  let best: { at: number; len: number; name?: string } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    let here: { at: number; len: number; name?: string } | null = null;
    for (const c of candidates) {
      const len = matchPhraseAt(tokens, i, c.phrase, WAKE_FUZZY_FLOOR);
      if (len === 0) continue;
      if (!here || len > here.len) here = { at: i, len, name: c.name };
    }
    if (!here) continue;
    if (!best) best = here;
    else if (prefer === 'last' && here.at > best.at) best = here;
    if (prefer === 'first') break;
  }
  if (!best) return { matched: false, rest: '', at: 0 };

  const after = tokens[best.at + best.len];
  return {
    matched: true,
    rest: after ? text.slice(after.start).trim() : '',
    at: after ? after.start : text.length,
    viaName: best.name,
  };
}

/** True when `text` consists of exactly the words of `phrase`. */
export function phraseEquals(text: string, phrase: string): boolean {
  const a = tokenize(text).map(t => t.word);
  const b = phraseWords(phrase);
  return b.length > 0 && a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * A commit word counts only when the recognizer delivered it *on its own*,
 * after a pause.
 *
 * The chunk test is what makes the pause meaningful. `gapMsBefore` measures the
 * silence before the chunk, not before its last word, so a chunk like
 * "fix the enter bug go" tells us nothing about whether the speaker paused
 * before "go" — and must not commit. Speech that really was "…the enter bug"
 * ‹pause› "go" arrives as two chunks, because the recognizer emits interim
 * results continuously while speech is flowing and stops when it is not.
 *
 * This kills the whole class of false positives at once: "go ahead and fix it"
 * and "remove the cancel button" both carry the word inside a larger chunk.
 */
export function isCommitWord(chunk: string, phrase: string, gapMsBefore: number): boolean {
  if (gapMsBefore < MIN_STOP_PAUSE_MS) return false;
  return phraseList(phrase).some(p => chunkIsPhrase(chunk, p));
}

/** True when `text` ends with the words of `phrase`. */
export function endsWithPhrase(text: string, phrase: string): boolean {
  const tokens = tokenize(text).map(t => t.word);
  const words = phraseWords(phrase);
  if (words.length === 0 || tokens.length < words.length) return false;
  const at = tokens.length - words.length;
  return words.every((w, j) => tokens[at + j] === w);
}

/** Removes a trailing occurrence of `phrase`, preserving the original casing and
 *  inner punctuation of what remains. Returns `text` unchanged if not trailing. */
export function stripTrailing(text: string, phrase: string): string {
  const tokens = tokenize(text);
  const words = phraseWords(phrase);
  if (words.length === 0 || tokens.length < words.length) return text.trim();

  const at = tokens.length - words.length;
  for (let j = 0; j < words.length; j++) {
    if (tokens[at + j].word !== words[j]) return text.trim();
  }
  return text.slice(0, tokens[at].start).trim();
}

/** Verbs that take no argument. Recognized only as a whole utterance. */
export const BARE_VERBS = [
  'spawn', 'stop', 'interrupt', 'next', 'previous', 'archive', 'mute',
  'yes', 'no', 'escape',
] as const;

/** Verbs that take the rest of the utterance as their argument. */
export const ARG_VERBS = ['select', 'open'] as const;

export type ControlVerb = typeof BARE_VERBS[number] | typeof ARG_VERBS[number];

export interface Utterance {
  kind: 'control' | 'prompt';
  verb?: ControlVerb;
  /** Argument for an ARG_VERB — the spoken worker name. */
  arg?: string;
  /** Text to inject, for kind='prompt'. Original casing preserved. */
  text: string;
}

/**
 * A bare verb counts as a command only when it is the entire utterance, so
 * "stop" is a command and "stop using that pattern" is a prompt. Predictable
 * beats clever here: a misread command does something, a misread prompt is
 * merely text the user can see and correct.
 */
export function classifyUtterance(rest: string): Utterance {
  const tokens = tokenize(rest);
  if (tokens.length === 0) return { kind: 'prompt', text: '' };

  const head = tokens[0].word;

  if (tokens.length === 1 && (BARE_VERBS as readonly string[]).includes(head)) {
    return { kind: 'control', verb: head as ControlVerb, text: rest.trim() };
  }
  if ((ARG_VERBS as readonly string[]).includes(head) && tokens.length > 1) {
    return {
      kind: 'control',
      verb: head as ControlVerb,
      arg: rest.slice(tokens[1].start).trim(),
      text: rest.trim(),
    };
  }
  return { kind: 'prompt', text: rest.trim() };
}

/** Levenshtein distance, iterative single-row. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 0..1 similarity. Exact match is 1; a clean prefix is treated generously
 *  because STT truncates trailing syllables far more often than it invents
 *  leading ones. */
export function similarity(spoken: string, candidate: string): number {
  const a = phraseWords(spoken).join(' ');
  const b = phraseWords(candidate).join(' ');
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) {
    return 0.9 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) + 0.1;
  }
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export interface NameCandidate {
  id: string;
  name: string;
}

export type NameMatch =
  | { kind: 'hit'; id: string; name: string; score: number }
  | { kind: 'ambiguous'; candidates: NameCandidate[] }
  | { kind: 'miss' };

/** Two candidates this close are reported as ambiguous rather than guessed. */
const AMBIGUITY_MARGIN = 0.05;

/**
 * Resolves a spoken worker name. Below `floor` the answer is a miss, never a
 * best guess — sending a prompt to the wrong worker is worse than sending
 * nothing, because the user has no reason to look for it there.
 */
export function fuzzyName(
  spoken: string,
  candidates: readonly NameCandidate[],
  floor: number,
): NameMatch {
  const scored = candidates
    .map(c => ({ ...c, score: similarity(spoken, c.name) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < floor) return { kind: 'miss' };

  const tied = scored.filter(c => c.score >= floor && top.score - c.score <= AMBIGUITY_MARGIN);
  if (tied.length > 1) {
    return { kind: 'ambiguous', candidates: tied.map(({ id, name }) => ({ id, name })) };
  }
  return { kind: 'hit', id: top.id, name: top.name, score: top.score };
}

/**
 * Strips a leading worker-name address off an utterance: "morion, fix the bug"
 * → target morion, text "fix the bug". Tries the longest prefix first so a
 * two-word name is not shadowed by a one-word one.
 */
export function stripLeadingAddress(
  rest: string,
  candidates: readonly NameCandidate[],
  floor: number,
): { match: NameMatch; text: string } {
  const tokens = tokenize(rest);
  const maxWords = Math.min(4, tokens.length);

  for (let n = maxWords; n >= 1; n--) {
    // A bare name with nothing after it is an address with an empty prompt,
    // which is useless — require at least one word of payload.
    if (n === tokens.length) continue;
    const spoken = tokens.slice(0, n).map(t => t.word).join(' ');
    const match = fuzzyName(spoken, candidates, floor);
    if (match.kind === 'hit' || match.kind === 'ambiguous') {
      return { match, text: rest.slice(tokens[n].start).trim() };
    }
  }
  return { match: { kind: 'miss' }, text: rest };
}
