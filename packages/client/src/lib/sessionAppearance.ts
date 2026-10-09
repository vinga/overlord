import type { DeskSpan, WorkerIcon } from '../types';

// Shared PUT helpers so every colour/icon picker (detail panel, terminal
// panel, room worker) talks to the same endpoints with the same logging.
function put(sessionId: string, field: 'color' | 'icon' | 'desk-span', body: Record<string, unknown>): void {
  void fetch(`/api/sessions/${sessionId}/${field}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) console.warn(`[${field}] PUT failed`, r.status, sessionId);
  }).catch(e => console.warn(`[${field}] PUT error`, e));
}

export function putSessionColor(sessionId: string, color: string): void {
  put(sessionId, 'color', { color });
}

export function putSessionIcon(sessionId: string, icon: WorkerIcon): void {
  put(sessionId, 'icon', { icon });
}

/** `null` = back to auto-size (the card takes the rows its content needs). */
export function putDeskSpan(sessionId: string, span: DeskSpan | null): void {
  put(sessionId, 'desk-span', span ? { w: span.w, h: span.h } : { auto: true });
}
