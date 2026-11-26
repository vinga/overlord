import { useEffect, useSyncExternalStore } from 'react';

/** A user question (or starred message) and the end of the agent's answer.
 *  `id` = the message's transcript timestamp = the feed's `data-user-msg`. */
export interface SessionQuestion {
  id: string;
  question: string;
  isQuestion: boolean;
  answerAt?: string;
  answer?: string;
}

interface Entry { questions: SessionQuestion[]; starred: Set<string>; loaded: boolean }

const EMPTY: Entry = { questions: [], starred: new Set(), loaded: false };

// One shared store per session, so the Q&A tab and the feed's stars agree.
const store = new Map<string, Entry>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function emit(): void { listeners.forEach(l => l()); }
function subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

export function loadQuestions(sessionId: string): Promise<void> {
  const running = inflight.get(sessionId);
  if (running) return running;
  const p = fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) as Promise<{ questions?: SessionQuestion[]; starred?: string[] }>)
    .then(d => {
      store.set(sessionId, { questions: d.questions ?? [], starred: new Set(d.starred ?? []), loaded: true });
      emit();
    })
    .catch(e => {
      console.warn('[questions] load failed', sessionId, e);
      // Leave "Loading…" for the empty state; keep any list already shown.
      const cur = store.get(sessionId);
      if (!cur?.loaded) { store.set(sessionId, { ...(cur ?? EMPTY), loaded: true }); emit(); }
    })
    .finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

/** Questions of a session. Refetches when `refreshKey` changes (the caller
 *  passes something that moves with new messages), never on a timer. */
export function useSessionQuestions(sessionId: string | undefined, refreshKey?: string): Entry {
  const entry = useSyncExternalStore(subscribe, () => (sessionId ? store.get(sessionId) ?? EMPTY : EMPTY));
  useEffect(() => {
    if (sessionId) void loadQuestions(sessionId);
  }, [sessionId, refreshKey]);
  return entry;
}

/** Star or unstar a user message. Optimistic; the list refetches so a
 *  starred non-question appears in it. */
export function setQuestionStar(sessionId: string, messageId: string, starred: boolean): void {
  const cur = store.get(sessionId) ?? EMPTY;
  const next = new Set(cur.starred);
  if (starred) next.add(messageId); else next.delete(messageId);
  store.set(sessionId, { ...cur, starred: next });
  emit();
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions/star`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: messageId, starred }),
  })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return loadQuestions(sessionId); })
    .catch(e => { console.warn('[questions] star failed', e); void loadQuestions(sessionId); });
}

/** Full markdown of one answer, cached per session + timestamp (an answer
 *  never changes once written). */
const answerCache = new Map<string, Promise<string>>();

export function fetchAnswer(sessionId: string, answerAt: string): Promise<string> {
  const key = `${sessionId}\n${answerAt}`;
  const hit = answerCache.get(key);
  if (hit) return hit;
  const p = fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions/answer?at=${encodeURIComponent(answerAt)}`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) as Promise<{ text?: string }>)
    .then(d => d.text ?? '');
  p.catch(() => answerCache.delete(key));
  answerCache.set(key, p);
  return p;
}

/** Window event: scroll the session feed to a user message (DetailPanel listens). */
export const JUMP_TO_MESSAGE_EVENT = 'overlord:jump-to-message';
export interface JumpToMessageDetail { sessionId: string; id: string }

export function jumpToMessage(sessionId: string, id: string): void {
  window.dispatchEvent(new CustomEvent<JumpToMessageDetail>(JUMP_TO_MESSAGE_EVENT, { detail: { sessionId, id } }));
}

/** "3m", "2h", "4d" — compact age for list rows. */
export function shortAge(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Same rule as the server index (questionIndex.isQuestion): a `?` outside
 *  fenced code, inline code, URLs and pasted `@/` paths. */
export function isQuestionText(text: string): boolean {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/@\/\S+/g, ' ')
    .includes('?');
}

/** Sticky "you" bar walks every message, or only questions + starred ones. */
export type StickyNavMode = 'all' | 'questions';
const NAV_MODE_KEY = 'overlord.stickyNavMode';
export const USER_MSG_SELECTOR: Record<StickyNavMode, string> = {
  all: '[data-user-msg]',
  questions: '[data-user-msg][data-user-question], [data-user-msg][data-user-starred]',
};

export function readStickyNavMode(): StickyNavMode {
  try { return localStorage.getItem(NAV_MODE_KEY) === 'questions' ? 'questions' : 'all'; } catch { return 'all'; }
}

export function saveStickyNavMode(mode: StickyNavMode): void {
  try { if (mode === 'all') localStorage.removeItem(NAV_MODE_KEY); else localStorage.setItem(NAV_MODE_KEY, mode); } catch { /* per-viewer only */ }
}
