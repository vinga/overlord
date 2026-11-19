import * as fs from 'fs';

/** One user question and the start of the agent's answer. `id` is the user
 *  message's transcript timestamp — the same value the feed puts in
 *  `data-user-msg`, so the client can jump to it. */
export interface SessionQuestion {
  id: string;
  question: string;
  /** True when the message has a `?` (outside code and URLs). Starred
   *  non-questions are listed too, with this false. */
  isQuestion: boolean;
  answerAt?: string;
  answer?: string;
}

/** A user message or assistant text, in transcript order. */
export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

// Same list as the client feed (DetailPanel SYNTHETIC_USER_PREFIXES), plus the
// teammate relay: none of these were typed by the user.
const SYNTHETIC_USER_PREFIXES = [
  '<environment_details',
  '<local-command',
  '<command-name>',
  '<command-message>',
  '<bash-input>',
  '<bash-stdout>',
  '<system-reminder',
  '<user-prompt-submit-hook',
  '<teammate-message',
  '<task-notification',
  'Caveat: The messages below',
  'This session is being continued from a previous conversation',
  'Continue from where you left off.',
  'Another Claude session sent a message:',
  'Base directory for this skill:',
];

export function isSyntheticUserText(text: string): boolean {
  const head = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some(p => head.startsWith(p));
}

/** Text with fenced code, inline code and URLs removed — a `?` there is not a question. */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/@\/\S+/g, ' ');
}

export function isQuestion(text: string): boolean {
  return proseOnly(text).includes('?');
}

const QUESTION_MAX = 200;
const ANSWER_MAX = 160;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The sentence holding the first `?`, else the first line. */
export function firstQuestionSentence(text: string): string {
  const prose = oneLine(proseOnly(text));
  const q = prose.indexOf('?');
  if (q === -1) return clip(oneLine(text.split('\n').find(l => l.trim()) ?? ''), QUESTION_MAX);
  // Sentence start: after the last . ! ? or newline-ish break before the `?`.
  const before = prose.slice(0, q);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const sentence = prose.slice(start === -1 ? 0 : start + 2, q + 1).trim();
  return clip(sentence || prose, QUESTION_MAX);
}

/** First prose of an answer: markdown markers and code dropped, one line. */
export function answerPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ');
  return clip(oneLine(plain), ANSWER_MAX);
}

/** Pair each typed user message that is a question (or starred) with the
 *  LAST assistant text before the next typed user message: the first one is
 *  usually a status line ("Checking…"), the last is the turn's conclusion.
 *  Turns with only tool calls carry no text entry.
 *
 *  Messages queued while the agent was busy get no text of their own before
 *  the next one arrives — they share the answer that follows, and an exact
 *  repeat of a still-unanswered question is listed once. */
export function extractQuestions(entries: ConversationEntry[], starred: ReadonlySet<string> = new Set()): SessionQuestion[] {
  const out: SessionQuestion[] = [];
  let pending: SessionQuestion[] = [];
  for (const e of entries) {
    if (e.role === 'assistant') {
      const preview = answerPreview(e.text);
      if (preview) for (const q of pending) { q.answer = preview; q.answerAt = e.timestamp; }
      continue;
    }
    if (isSyntheticUserText(e.text)) continue;
    // A new message ends the turn for answered questions; unanswered ones wait on.
    pending = pending.filter(q => !q.answer);
    const q = isQuestion(e.text);
    const isStarred = starred.has(e.timestamp);
    if (!q && !isStarred) continue;
    const question = firstQuestionSentence(e.text);
    if (!isStarred && pending.some(p => p.question === question)) continue;
    const item: SessionQuestion = { id: e.timestamp, question, isQuestion: q };
    out.push(item);
    pending.push(item);
  }
  return out;
}

interface RawLine {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  attachment?: { type?: string; prompt?: string; timestamp?: string; origin?: { kind?: string } };
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}

function firstText(content: string | Array<{ type?: string; text?: string }> | undefined): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(b => b.type === 'text')?.text;
  return undefined;
}

/** One transcript line → an entry, mirroring how the feed reads it
 *  (readActivityBefore): typed user text, queued human prompts, assistant text. */
export function parseEntry(line: string): ConversationEntry | null {
  let p: RawLine;
  try { p = JSON.parse(line) as RawLine; } catch { return null; }
  if (p.type === 'attachment' && p.attachment?.type === 'queued_command' && p.attachment.origin?.kind === 'human') {
    const prompt = p.attachment.prompt;
    const ts = p.attachment.timestamp ?? p.timestamp;
    return typeof prompt === 'string' && prompt.trim() && ts ? { role: 'user', text: prompt, timestamp: ts } : null;
  }
  if ((p.type !== 'user' && p.type !== 'assistant') || !p.timestamp) return null;
  if (p.type === 'user' && p.isMeta) return null;   // skill preambles
  const text = firstText(p.message?.content);
  if (!text || !text.trim()) return null;
  return { role: p.type, text, timestamp: p.timestamp };
}

interface CacheEntry { size: number; mtimeMs: number; offset: number; entries: ConversationEntry[] }
const cache = new Map<string, CacheEntry>();
const MAX_CACHED_FILES = 50;
const CHUNK = 4 * 1024 * 1024;

/** All conversation entries of a transcript. Re-reads only the bytes appended
 *  since the last call; a shrunk or replaced file is read from scratch. */
export function readConversation(filePath: string): ConversationEntry[] {
  let st: fs.Stats;
  try { st = fs.statSync(filePath); } catch { cache.delete(filePath); return []; }
  let c = cache.get(filePath);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.entries;
  if (!c || st.size < c.offset) c = { size: 0, mtimeMs: 0, offset: 0, entries: [] };
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    while (c.offset < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - c.offset), c.offset);
      if (n <= 0) break;
      // Consume whole lines only: an unfinished last line (still being
      // written, or a multi-byte char cut by the chunk) is read next time.
      const end = buf.subarray(0, n).lastIndexOf(0x0a);
      if (end === -1) break;   // one line longer than CHUNK, or no newline yet
      c.offset += end + 1;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('queued_command')) continue;
        const e = parseEntry(line);
        if (e) c.entries.push(e);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  c.size = st.size;
  c.mtimeMs = st.mtimeMs;
  cache.delete(filePath);
  cache.set(filePath, c);
  if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value as string);
  return c.entries;
}

export function clearQuestionCache(): void {
  cache.clear();
}
