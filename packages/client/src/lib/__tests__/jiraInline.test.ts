import { describe, it, expect, beforeEach } from 'vitest';
import { setJiraProjectAllowlist, browseKeyFromUrl, collectInlineMatches } from '../jiraInline.js';

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
    expect(browseKeyFromUrl('https://x.atlassian.net/browse/BACKEND-1')).toBe('BACKEND-1');
    expect(browseKeyFromUrl('https://x.atlassian.net/projects/BACKEND')).toBeNull();
    expect(browseKeyFromUrl('https://x.atlassian.net/browse/OTHER-1')).toBeNull();
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
