/**
 * Live dictation bridge between the voice agent (mounted in App) and the
 * message composer (deep inside DetailPanel).
 *
 * A module-level store rather than props: the composer is many levels down and
 * re-renders on every WebSocket tick, so threading a fast-changing string
 * through would re-render the whole panel on every interim speech result.
 * Subscribers here update only the composer's own state.
 */

export interface Dictation {
  /** Worker the text is destined for, or null when nothing is being dictated. */
  ovrId: string | null;
  /** Text heard so far, with the start word already stripped. */
  text: string;
}

let current: Dictation = { ovrId: null, text: '' };
const listeners = new Set<(d: Dictation) => void>();

export function setDictation(ovrId: string | null, text: string): void {
  if (current.ovrId === ovrId && current.text === text) return;
  current = { ovrId, text };
  for (const l of listeners) {
    try { l(current); } catch { /* a bad subscriber must not stop the rest */ }
  }
}

export function getDictation(): Dictation {
  return current;
}

export function subscribeDictation(listener: (d: Dictation) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Submit channel. The stop word should behave exactly like pressing Enter in
 * the composer — same local echo, same sent-history entry, same image
 * attachment and compaction guard — so it asks the composer to send rather
 * than injecting behind its back.
 */
type SubmitListener = (ovrId: string, text: string) => void;
const submitListeners = new Set<SubmitListener>();

export function requestDictationSubmit(ovrId: string, text: string): void {
  for (const l of submitListeners) {
    try { l(ovrId, text); } catch { /* a bad subscriber must not stop the rest */ }
  }
}

export function subscribeDictationSubmit(listener: SubmitListener): () => void {
  submitListeners.add(listener);
  return () => submitListeners.delete(listener);
}

/**
 * A manual edit of the composer during dictation. From then on the composer
 * shows `base` (the user's text) plus only what was heard after `heardAt` —
 * so deleted words stay deleted instead of returning with the next result.
 */
export interface DictationEdit {
  base: string;
  /** Full transcript at the moment of the edit. */
  heardAt: string;
}

/** The part of `heard` spoken after `heardAt`. The engine may revise earlier
 *  words, so when `heardAt` is no longer a prefix the cut is by word count. */
export function heardSince(heard: string, heardAt: string): string {
  if (heard.startsWith(heardAt)) return heard.slice(heardAt.length).trim();
  const skip = heardAt.trim() === '' ? 0 : heardAt.trim().split(/\s+/).length;
  return heard.trim().split(/\s+/).slice(skip).join(' ');
}

/** Composer text for `heard`, honouring a manual edit if there was one. */
export function mergeDictation(edit: DictationEdit | null, heard: string): string {
  if (!edit) return heard;
  const tail = heardSince(heard, edit.heardAt);
  if (tail === '') return edit.base;
  if (edit.base.trim() === '') return tail;
  return /\s$/.test(edit.base) ? `${edit.base}${tail}` : `${edit.base} ${tail}`;
}
