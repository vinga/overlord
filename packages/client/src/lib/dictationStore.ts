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
