// Durable draft persistence for the message composer, keyed by session id.
// The in-memory draftPerSession map survives session switches but NOT page
// reload / HMR / crash. localStorage does — so unsent text is never lost.
const PREFIX = 'overlord.draft.';

export function loadDraft(id: string | undefined): string {
  if (!id) return '';
  try {
    return localStorage.getItem(PREFIX + id) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(id: string | undefined, text: string): void {
  if (!id) return;
  try {
    if (text) localStorage.setItem(PREFIX + id, text);
    else localStorage.removeItem(PREFIX + id);
  } catch {
    /* quota exceeded / private mode — best effort only */
  }
}

export function clearDraft(id: string | undefined): void {
  if (!id) return;
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    /* ignore */
  }
}
