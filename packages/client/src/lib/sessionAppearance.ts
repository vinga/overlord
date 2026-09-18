import type { WorkerIcon } from '../types';

// Shared PUT helpers so every colour/icon picker (detail panel, terminal
// panel, room worker) talks to the same endpoints with the same logging.
function put(sessionId: string, field: 'color' | 'icon', body: Record<string, string>): void {
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
