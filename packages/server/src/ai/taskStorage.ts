import { sessionStore } from '../session/sessionStore.js';

// ── Acknowledged flag ────────────────────────────────────────────────────────

export function saveAck(sessionId: string, acknowledged: boolean): void {
  sessionStore.patchBySessionId(sessionId, { acknowledged: acknowledged ? true : undefined });
}

export function loadAck(sessionId: string): boolean {
  return sessionStore.getBySessionId(sessionId)?.acknowledged === true;
}

// ── Legacy stub ──────────────────────────────────────────────────────────────

/** @deprecated Request summaries are replaced by Task.title. No-op kept for compat. */
export function saveRequestSummary(_sessionId: string, _summary: string): void {
  // no-op
}
