// Durable history of messages the user actually sent, keyed by overlordId.
// The composer clears as soon as injectText succeeds — but a send issued in the
// tick before `isCompacting` lands is swallowed by a compacting TUI and the text
// exists nowhere. This ring is the recovery path (↑ in the composer).
const PREFIX = 'overlord.sent.';
const MAX_ENTRIES = 50;
const MAX_BYTES = 64_000;

export type SentEntry = { text: string; ts: number };

/** Newest-first. Returns [] on any read/parse failure. */
export function loadSentHistory(id: string | undefined): SentEntry[] {
  if (!id) return [];
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SentEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(e => e && typeof e.text === 'string' && typeof e.ts === 'number');
  } catch {
    return [];
  }
}

/**
 * Prepend `text`. Re-sending the same text as the newest entry only refreshes its
 * timestamp. Returns the new list so callers can drop it straight into state.
 */
export function pushSentHistory(id: string | undefined, text: string, nowMs: number): SentEntry[] {
  if (!id || !text.trim()) return loadSentHistory(id);
  const prev = loadSentHistory(id);
  const next: SentEntry[] = prev[0]?.text === text
    ? [{ text, ts: nowMs }, ...prev.slice(1)]
    : [{ text, ts: nowMs }, ...prev];
  next.length = Math.min(next.length, MAX_ENTRIES);
  // Byte cap: drop oldest until the serialized ring fits.
  let serialized = JSON.stringify(next);
  while (next.length > 1 && serialized.length > MAX_BYTES) {
    next.pop();
    serialized = JSON.stringify(next);
  }
  try {
    localStorage.setItem(PREFIX + id, serialized);
  } catch {
    /* quota exceeded / private mode — in-memory copy is still returned */
  }
  return next;
}

export function clearSentHistory(id: string | undefined): void {
  if (!id) return;
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    /* ignore */
  }
}
