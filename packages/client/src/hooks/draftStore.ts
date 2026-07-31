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

/**
 * Drafts used to be keyed by sessionId, which rotates on compaction / /clear /
 * resume — stranding the durable copy under a key nothing reads back. Move any
 * legacy value onto the stable overlordId key, once, on session switch.
 */
export function migrateDraftKey(fromId: string | undefined, toId: string | undefined): void {
  if (!fromId || !toId || fromId === toId) return;
  try {
    const legacy = localStorage.getItem(PREFIX + fromId);
    if (legacy === null) return;
    if (localStorage.getItem(PREFIX + toId) === null && legacy) {
      localStorage.setItem(PREFIX + toId, legacy);
    }
    localStorage.removeItem(PREFIX + fromId);
  } catch {
    /* ignore */
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
