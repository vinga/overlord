// Inline JIRA tokens in the conversation feed. The server-side transcript
// scanner only mines user-authored text, so a ticket the assistant mentioned
// never becomes a chip on its own — these tokens carry a hover `+` that pins it
// (POST /api/sessions/:id/jira-keys/:key). Kept DOM-free so the matching rules
// are unit-testable; the rendering lives in DetailPanel.

// Absolute Unix paths (/a/b/c) and Windows paths (C:\a\b or C:/a/b) with optional :line or :line:col.
export const PATH_REGEX = /(?:\/[\w.\-+@]+){2,}(?::\d+(?::\d+)?)?|[A-Za-z]:[\\/](?:[\w.\-+@]+[\\/]?)+(?::\d+(?::\d+)?)?/g;

// Any URL. Used as a suppression range: PATH_REGEX happily reads
// `/host.tld/browse/KEY` out of one and would turn it into an "open file" link.
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
// Ticket URLs — `https://acme.atlassian.net/browse/KEY`, plus whatever query or
// hash follows. Matched whole so the token covers the URL rather than leaving a
// bare key wrapped in loose text.
const JIRA_URL_REGEX = /https?:\/\/[^\s<>"']*\/browse\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})[^\s<>"']*/g;
const BROWSE_PATH_REGEX = /\/browse\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})/;
// Sentence punctuation that trails a URL in prose is not part of it.
const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;

let jiraProjectsSource = '';
let jiraKeyRegex: RegExp | null = null;

/** Rebuild the matcher from the settings allowlist (`jiraProjects`). Returns
 *  true when the allowlist actually changed, so the caller can drop any
 *  markdown it rendered with the previous one. */
export function setJiraProjectAllowlist(raw: string | undefined): boolean {
  const source = (raw ?? '').trim();
  if (source === jiraProjectsSource) return false;
  jiraProjectsSource = source;
  const tokens = source
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]{1,9}$/.test(s));
  jiraKeyRegex = tokens.length > 0
    ? new RegExp(String.raw`\b(?:${tokens.join('|')})-\d{1,6}\b`, 'g')
    : null;
  return true;
}

export function hasJiraAllowlist(): boolean {
  return jiraKeyRegex !== null;
}

/** The allowlisted ticket key a `/browse/…` URL points at, or null. */
export function browseKeyFromUrl(url: string): string | null {
  if (!jiraKeyRegex) return null;
  const m = BROWSE_PATH_REGEX.exec(url);
  if (!m) return null;
  const key = m[1].toUpperCase();
  jiraKeyRegex.lastIndex = 0;
  return jiraKeyRegex.test(key) ? key : null;
}

export type InlineMatch = { index: number; text: string; kind: 'path' | 'jira'; key?: string };

/** Path, bare-key and ticket-URL matches in one text node, left to right,
 *  overlaps dropped: a key inside a path (/repo/BACKEND-1/x) stays part of the
 *  path, and a ticket URL beats the path buried inside it. */
export function collectInlineMatches(text: string): InlineMatch[] {
  const found: InlineMatch[] = [];
  let m: RegExpExecArray | null;
  // URL spans first — everything else defers to them.
  const urls: Array<[number, number]> = [];
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(text))) {
    const trimmed = m[0].replace(TRAILING_PUNCT, '');
    if (trimmed) urls.push([m.index, m.index + trimmed.length]);
  }
  const insideUrl = (i: number) => urls.some(([s, e]) => i >= s && i < e);
  if (jiraKeyRegex) {
    JIRA_URL_REGEX.lastIndex = 0;
    while ((m = JIRA_URL_REGEX.exec(text))) {
      const url = m[0].replace(TRAILING_PUNCT, '');
      const key = browseKeyFromUrl(url);
      if (key) found.push({ index: m.index, text: url, kind: 'jira', key });
    }
  }
  PATH_REGEX.lastIndex = 0;
  while ((m = PATH_REGEX.exec(text))) {
    if (insideUrl(m.index)) continue;
    found.push({ index: m.index, text: m[0], kind: 'path' });
  }
  if (jiraKeyRegex) {
    jiraKeyRegex.lastIndex = 0;
    while ((m = jiraKeyRegex.exec(text))) {
      if (insideUrl(m.index)) continue;
      found.push({ index: m.index, text: m[0], kind: 'jira', key: m[0] });
    }
  }
  if (found.length < 2) return found;
  // Longest first at equal offsets so an overlapping shorter match loses.
  found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const out: InlineMatch[] = [];
  let end = 0;
  for (const f of found) {
    if (f.index < end) continue;
    out.push(f);
    end = f.index + f.text.length;
  }
  return out;
}
