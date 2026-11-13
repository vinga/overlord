import type { JiraIssueMeta } from '../types';
import { jiraSessionTitle, jiraTypeToWorkerIcon } from './jiraIcon';
import { ICON_COLORS } from '../components/iconColors';

function put(sessionId: string, path: string, body: unknown): Promise<void> {
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => {
    if (!r.ok) console.warn(`[jira-adopt] ${path} PUT failed`, r.status, sessionId);
  }).catch(e => console.warn(`[jira-adopt] ${path} PUT error`, e));
}

/** Adopt the ticket onto the session: title becomes "KEY Summary", and — only
 *  when the Jira issue type resolved — the avatar takes the matching glyph and
 *  its paired colour. An undeducible type leaves icon and colour untouched.
 *  `onRename` is the optimistic rename path; without it the name is PUT directly. */
export function adoptJiraTicket(
  sessionId: string,
  key: string,
  meta: JiraIssueMeta | undefined,
  onRename?: (name: string) => void,
): void {
  const name = jiraSessionTitle(key, meta?.title);
  if (onRename) onRename(name);
  else void put(sessionId, 'name', { name });

  const icon = jiraTypeToWorkerIcon(meta?.type);
  if (icon) {
    void put(sessionId, 'icon', { icon });
    void put(sessionId, 'color', { color: ICON_COLORS[icon] });
  }
}
