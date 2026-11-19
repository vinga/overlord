/** Shell (raw) session history trimming — burger-menu action. */

export const SHELL_HISTORY_KEEP_LINES = 500;

/** Window event fired after a trim; useTerminal repaints that terminal. */
export const SHELL_HISTORY_TRIMMED_EVENT = 'overlord:shell-history-trimmed';

export async function fetchShellHistoryLines(sessionId: string): Promise<number | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shell-history`);
    if (!r.ok) return null;
    const { lines } = await r.json() as { lines?: number };
    return typeof lines === 'number' ? lines : null;
  } catch {
    return null;
  }
}

export async function trimShellHistory(sessionId: string, ovrId: string, keepLines = SHELL_HISTORY_KEEP_LINES): Promise<boolean> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shell-history/trim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepLines }),
    });
    if (!r.ok) { console.warn('[shell-history] trim failed', r.status, sessionId); return false; }
    window.dispatchEvent(new CustomEvent(SHELL_HISTORY_TRIMMED_EVENT, { detail: { ovrId } }));
    return true;
  } catch (e) {
    console.warn('[shell-history] trim error', e);
    return false;
  }
}
