import { describe, it, expect, beforeEach } from 'vitest';
import { setJiraProjectAllowlist, urlTicketKey, prUrlRef, collectInlineMatches, splitPathLine } from '../jiraInline.js';

const summarize = (text: string) =>
  collectInlineMatches(text).map((m) => `${m.kind}:${m.key ?? m.text}`);

describe('inline ticket matching', () => {
  beforeEach(() => {
    // Force a rebuild — the allowlist is module state shared across tests.
    setJiraProjectAllowlist('');
    setJiraProjectAllowlist('BACKEND, API');
  });

  it('matches bare keys for allowlisted projects only', () => {
    expect(summarize('see BACKEND-2278 and API-7')).toEqual(['jira:BACKEND-2278', 'jira:API-7']);
    expect(summarize('see OTHER-2278')).toEqual([]);
  });

  it('tokenizes a board URL that carries the key in a query param', () => {
    const matches = collectInlineMatches(
      'see https://x.atlassian.net/jira/software/projects/BACKEND/boards/2?selectedIssue=BACKEND-2278 here',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].key).toBe('BACKEND-2278');
    expect(matches[0].text).toContain('selectedIssue=BACKEND-2278');
  });

  it('leaves a branch URL alone', () => {
    expect(summarize('https://github.com/org/repo/tree/BACKEND-2278-code-agent')).toEqual([]);
  });

  it('matches a full ticket URL as one token carrying the key', () => {
    const matches = collectInlineMatches('fix https://hypatos.atlassian.net/browse/BACKEND-2278 today');
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('jira');
    expect(matches[0].key).toBe('BACKEND-2278');
    // The visible token covers the whole URL, not just the key.
    expect(matches[0].text).toBe('https://hypatos.atlassian.net/browse/BACKEND-2278');
  });

  it('keeps a query string or hash out of the key', () => {
    const [m] = collectInlineMatches('https://x.atlassian.net/browse/BACKEND-2278?focusedId=1#c');
    expect(m.key).toBe('BACKEND-2278');
    expect(m.text).toContain('?focusedId=1');
  });

  it('accepts http and a lowercase key', () => {
    const [m] = collectInlineMatches('http://jira.local/browse/backend-12');
    expect(m.key).toBe('BACKEND-12');
  });

  it('ignores a browse URL for a project outside the allowlist', () => {
    expect(summarize('https://x.atlassian.net/browse/OTHER-12')).toEqual([]);
  });

  it('never turns a URL into a file-path link', () => {
    expect(summarize('docs at https://acme.dev/a/b/c and /real/local/path.ts')).toEqual([
      'path:/real/local/path.ts',
    ]);
  });

  it('drops sentence punctuation trailing a ticket URL', () => {
    const [m] = collectInlineMatches('see https://x.atlassian.net/browse/BACKEND-2278.');
    expect(m.text).toBe('https://x.atlassian.net/browse/BACKEND-2278');
  });

  it('does not leave the path inside a ticket URL as a file link', () => {
    // PATH_REGEX would otherwise claim /browse/BACKEND-2278 and win the span.
    expect(summarize('https://hypatos.atlassian.net/browse/BACKEND-2278')).toEqual(['jira:BACKEND-2278']);
  });

  it('keeps a key that is part of a file path inside the path', () => {
    expect(summarize('/Users/me/PLANS/BACKEND-2278-code-agent/plan.md')).toEqual([
      'path:/Users/me/PLANS/BACKEND-2278-code-agent/plan.md',
    ]);
  });

  it('returns paths, URLs and bare keys in document order', () => {
    expect(
      summarize('/a/b/c.ts then https://x.atlassian.net/browse/API-3 then BACKEND-9'),
    ).toEqual(['path:/a/b/c.ts', 'jira:API-3', 'jira:BACKEND-9']);
  });

  it('resolves keys from URLs independently of surrounding text', () => {
    expect(urlTicketKey('https://x.atlassian.net/browse/BACKEND-1')).toBe('BACKEND-1');
    expect(urlTicketKey('https://x.atlassian.net/projects/BACKEND')).toBeNull();
    expect(urlTicketKey('https://x.atlassian.net/browse/OTHER-1')).toBeNull();
  });

  // `/browse/` is one layout among several — the key can sit in any path
  // segment, a query param, or the hash.
  it.each([
    ['https://x.atlassian.net/browse/BACKEND-2278', 'BACKEND-2278'],
    ['https://x.atlassian.net/jira/software/c/projects/BACKEND/issues/BACKEND-2278', 'BACKEND-2278'],
    ['https://x.atlassian.net/jira/software/projects/BACKEND/boards/12?selectedIssue=BACKEND-2278', 'BACKEND-2278'],
    ['https://x.atlassian.net/secure/RapidBoard.jspa?rapidView=1&modal=detail&selectedIssue=BACKEND-2278', 'BACKEND-2278'],
    ['https://x.atlassian.net/issues/?jql=key%3DBACKEND-2278', 'BACKEND-2278'],
    ['https://x.atlassian.net/browse/BACKEND-2278#comment-1', 'BACKEND-2278'],
    ['https://x.atlassian.net/servicedesk/customer/portal/1/BACKEND-2278', 'BACKEND-2278'],
  ])('reads the key out of %s', (url, key) => {
    expect(urlTicketKey(url)).toBe(key);
  });

  it('does not treat a branch or file URL as a ticket link', () => {
    // The key is a prefix of a longer slug — a branch name, not a ticket.
    expect(urlTicketKey('https://github.com/org/repo/tree/BACKEND-2278-code-agent')).toBeNull();
    expect(urlTicketKey('https://github.com/org/repo/blob/main/BACKEND-2278-notes.md')).toBeNull();
  });

  it('still tokenizes a non-Jira URL that links the ticket cleanly', () => {
    // A key standing alone in any URL is a deliberate reference; the host is
    // not something we can allowlist (self-hosted Jira, short links, proxies).
    expect(urlTicketKey('https://jira.internal.corp/browse/BACKEND-2278')).toBe('BACKEND-2278');
    expect(urlTicketKey('https://github.com/org/repo/pull/1#BACKEND-2278')).toBe('BACKEND-2278');
  });

  it('produces no ticket tokens when no allowlist is configured', () => {
    setJiraProjectAllowlist('');
    expect(summarize('BACKEND-2278 and https://x.atlassian.net/browse/BACKEND-2278')).toEqual([]);
  });

  it('reports whether the allowlist actually changed', () => {
    expect(setJiraProjectAllowlist('BACKEND, API')).toBe(false);
    expect(setJiraProjectAllowlist('BACKEND')).toBe(true);
  });
});

describe('splitPathLine', () => {
  it('passes a plain path through', () => {
    expect(splitPathLine('/a/b/file.ts')).toEqual({ path: '/a/b/file.ts' });
  });

  it('splits a :line suffix', () => {
    expect(splitPathLine('/a/b/file.ts:12')).toEqual({ path: '/a/b/file.ts', line: 12 });
  });

  it('splits a :line:col suffix, keeping only the line', () => {
    expect(splitPathLine('/a/b/file.ts:12:5')).toEqual({ path: '/a/b/file.ts', line: 12 });
  });

  it('does not eat the Windows drive colon', () => {
    expect(splitPathLine('C:\\a\\b.ts:12')).toEqual({ path: 'C:\\a\\b.ts', line: 12 });
    expect(splitPathLine('C:\\a\\b.ts')).toEqual({ path: 'C:\\a\\b.ts' });
  });

  it('leaves a digit-final path segment alone', () => {
    expect(splitPathLine('/a/b/v2')).toEqual({ path: '/a/b/v2' });
  });
});

describe('inline PR matching', () => {
  beforeEach(() => {
    setJiraProjectAllowlist('');
    setJiraProjectAllowlist('BACKEND, API');
  });

  it.each([
    ['https://github.com/hypatos/prompting-service/pull/819', 'hypatos/prompting-service#819'],
    ['https://github.com/o/r/pull/12/files', 'o/r#12'],
    ['https://github.com/o/r/pull/12#discussion_r99', 'o/r#12'],
    ['https://github.com/o/r/pull/12?w=1', 'o/r#12'],
    // GitHub Enterprise — private host, same path shape.
    ['https://github.acme.internal/team/svc/pull/44', 'team/svc#44'],
  ])('resolves %s', (url, ref) => {
    expect(prUrlRef(url)).toBe(ref);
  });

  it.each([
    ['https://github.com/o/r/pulls'],
    ['https://github.com/o/r/pull/abc'],
    ['https://github.com/o/r/pull/0'],
    ['https://github.com/o/r/issues/12'],
    ['https://github.com/o/r/tree/BACKEND-2278-fix'],
  ])('rejects %s', (url) => {
    expect(prUrlRef(url)).toBe(null);
  });

  it('tokenizes a PR URL in prose', () => {
    expect(summarize('opened https://github.com/o/r/pull/12 just now'))
      .toEqual(['pr:o/r#12']);
  });

  it('beats the ticket rule when a PR URL also carries a key', () => {
    // The branch segment of a PR URL routinely holds the ticket key. It is
    // still a PR link, and the `+` must pin the PR, not the ticket.
    expect(summarize('https://github.com/o/r/pull/12?head=BACKEND-2278'))
      .toEqual(['pr:o/r#12']);
  });

  it('does not turn a PR URL into a bogus file path', () => {
    const kinds = collectInlineMatches('https://github.com/o/r/pull/12').map((m) => m.kind);
    expect(kinds).toEqual(['pr']);
  });

  it('keeps ticket URLs as tickets', () => {
    expect(summarize('https://x.atlassian.net/browse/BACKEND-2278'))
      .toEqual(['jira:BACKEND-2278']);
  });

  it('handles a PR URL and a bare key on one line', () => {
    expect(summarize('BACKEND-2278 → https://github.com/o/r/pull/12'))
      .toEqual(['jira:BACKEND-2278', 'pr:o/r#12']);
  });

  it('detects PR URLs with no ticket allowlist configured', () => {
    setJiraProjectAllowlist('');
    expect(summarize('https://github.com/o/r/pull/12')).toEqual(['pr:o/r#12']);
  });
});
