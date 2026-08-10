// Inline JIRA and pull-request tokens in the conversation feed.
//
// Tickets: the server-side transcript scanner only mines user-authored text, so
// a ticket the assistant mentioned never becomes a chip on its own — these
// tokens carry a hover `+` that pins it (POST /api/sessions/:id/jira-keys/:key).
//
// PRs: autodetected server-side from PR URLs anywhere in the transcript, so the
// `+` here (POST /api/sessions/:id/pr-refs) is for adopting one the tail window
// has already scrolled past, or one detection dropped at the cap.
//
// Kept DOM-free so the matching rules are unit-testable; rendering lives in
// DetailPanel.

// Absolute Unix paths (/a/b/c) and Windows paths (C:\a\b or C:/a/b) with optional :line or :line:col.
export const PATH_REGEX = /(?:\/[\w.\-+@]+){2,}(?::\d+(?::\d+)?)?|[A-Za-z]:[\\/](?:[\w.\-+@]+[\\/]?)+(?::\d+(?::\d+)?)?/g;

// Any URL. Used as a suppression range: PATH_REGEX happily reads
// `/host.tld/browse/KEY` out of one and would turn it into an "open file" link.
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
// Sentence punctuation that trails a URL in prose is not part of it.
const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;
// A key inside a URL only counts when URL punctuation delimits it on both
// sides. `/browse/KEY` is just one layout — the same key rides `/issues/KEY`,
// `?selectedIssue=KEY`, `#KEY` and whatever Atlassian ships next — but
// `/tree/KEY-some-branch` is a branch name, not a ticket link.
const KEY_DELIM_BEFORE = /[/=?&#:]/;
const KEY_DELIM_AFTER = /[/?&#=]/;

let jiraProjectsSource = '';
let jiraKeyRegex: RegExp | null = null;
// Same allowlist, case-insensitive — URLs carry lowercased keys often enough.
let jiraKeyRegexCI: RegExp | null = null;

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
  const pattern = String.raw`\b(?:${tokens.join('|')})-\d{1,6}\b`;
  jiraKeyRegex = tokens.length > 0 ? new RegExp(pattern, 'g') : null;
  jiraKeyRegexCI = tokens.length > 0 ? new RegExp(pattern, 'gi') : null;
  return true;
}

export function hasJiraAllowlist(): boolean {
  return jiraKeyRegex !== null;
}

/** The allowlisted ticket key a URL points at, whatever layout the Jira
 *  instance uses (`/browse/KEY`, `/issues/KEY`, `?selectedIssue=KEY`, …), or
 *  null when the URL merely happens to contain the key — a branch or file name
 *  like `/tree/KEY-add-thing`. */
export function urlTicketKey(url: string): string | null {
  if (!jiraKeyRegexCI) return null;
  // Decoded so a percent-encoded delimiter (JQL links carry `key%3DKEY`) still
  // reads as one. Only the key is taken from this, never an offset.
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* malformed escape — scan as-is */ }
  jiraKeyRegexCI.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = jiraKeyRegexCI.exec(decoded))) {
    const before = m.index === 0 ? '' : decoded[m.index - 1];
    const after = decoded[m.index + m[0].length] ?? '';
    const okBefore = before !== '' && KEY_DELIM_BEFORE.test(before);
    const okAfter = after === '' || KEY_DELIM_AFTER.test(after);
    if (okBefore && okAfter) return m[0].toUpperCase();
  }
  return null;
}

// A pull request URL, any host (GitHub Enterprise lives on private domains) —
// the `/pull/<digits>` path segment is what identifies it. Mirrors the server's
// parsePrUrl; duplicated on purpose so this module stays dependency-free.
const PR_URL_REGEX = /^https?:\/\/[^/\s]+\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#]|$)/;

/** The `owner/repo#number` a URL points at, or null when it isn't a PR link. */
export function prUrlRef(url: string): string | null {
  const m = PR_URL_REGEX.exec(url.trim().replace(TRAILING_PUNCT, ''));
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `${m[1]}/${m[2]}#${number}`;
}

export type InlineMatch = { index: number; text: string; kind: 'path' | 'jira' | 'pr'; key?: string };

/** Split a matched path token into the bare path and the optional trailing
 *  `:line(:col)` reference. The Windows drive colon never matches — it is
 *  followed by a separator, not digits at end-of-token. */
export function splitPathLine(text: string): { path: string; line?: number } {
  const m = /:(\d+)(?::\d+)?$/.exec(text);
  if (!m) return { path: text };
  return { path: text.slice(0, m.index), line: parseInt(m[1], 10) };
}

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
    const url = m[0].replace(TRAILING_PUNCT, '');
    if (!url) continue;
    urls.push([m.index, m.index + url.length]);
    // PR first: a PR URL routinely carries a ticket key in the branch segment
    // (…/pull/12 from BACKEND-2278-fix), and it is a PR link, not a ticket link.
    const prRef = prUrlRef(url);
    if (prRef) {
      found.push({ index: m.index, text: url, kind: 'pr', key: prRef });
      continue;
    }
    const key = urlTicketKey(url);
    if (key) found.push({ index: m.index, text: url, kind: 'jira', key });
  }
  const insideUrl = (i: number) => urls.some(([s, e]) => i >= s && i < e);
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
