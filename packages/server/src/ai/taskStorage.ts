import { sessionStore } from '../session/sessionStore.js';

// ── Completion hint ──────────────────────────────────────────────────────────

export function saveCompletionHint(sessionId: string, hint: 'done' | 'awaiting'): void {
  sessionStore.patchBySessionId(sessionId, { completionHint: hint });
}

export function loadCompletionHint(sessionId: string): 'done' | 'awaiting' | undefined {
  return sessionStore.getBySessionId(sessionId)?.completionHint;
}

export function clearCompletionHint(sessionId: string): void {
  sessionStore.patchBySessionId(sessionId, { completionHint: undefined, completionHintByUser: undefined, manuallyDone: undefined });
}

export function saveCompletionHintByUser(sessionId: string, byUser: boolean): void {
  sessionStore.patchBySessionId(sessionId, { completionHintByUser: byUser ? true : undefined });
}

export function saveManuallyDone(sessionId: string, value: boolean): void {
  sessionStore.patchBySessionId(sessionId, { manuallyDone: value ? true : undefined });
}

export function loadManuallyDone(sessionId: string): boolean {
  return sessionStore.getBySessionId(sessionId)?.manuallyDone === true;
}

export function loadCompletionHintByUser(sessionId: string): boolean {
  return sessionStore.getBySessionId(sessionId)?.completionHintByUser === true;
}

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
