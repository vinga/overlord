import type { WorkerIcon } from '../types';

/**
 * Map a JIRA `issuetype.name` onto one of the existing worker glyphs.
 *
 * Returns `undefined` when the type is absent or unrecognised — callers must
 * treat that as "no opinion" and leave the current icon alone, which is why
 * this can't just fall through to 'task'.
 *
 * Test order mirrors `JiraTypeIcon.classify`: "Sub-task" contains "task", so
 * the `sub` branch has to come first.
 */
export function jiraTypeToWorkerIcon(type?: string): WorkerIcon | undefined {
  const t = (type ?? '').toLowerCase();
  if (!t) return undefined;
  if (t.includes('sub')) return 'task';                    // no dedicated sub-task glyph
  if (t.includes('bug') || t.includes('defect')) return 'bug';
  if (t.includes('epic')) return 'ticket';                 // violet ticket stands in for epic
  if (t.includes('story')) return 'story';
  if (t.includes('task')) return 'task';
  return undefined;
}

/** Session title adopted from a ticket: "KEY Summary", or the bare key when the
 *  summary hasn't resolved yet (no JIRA creds, or still fetching). */
export function jiraSessionTitle(key: string, title?: string): string {
  const summary = title?.trim();
  return summary ? `${key} ${summary}` : key;
}
