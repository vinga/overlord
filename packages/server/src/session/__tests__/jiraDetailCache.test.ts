import { describe, it, expect, vi, beforeEach } from 'vitest';

const creds = { set: true };
vi.mock('../globalSettingsStore.js', () => ({
  globalSettingsStore: {
    get: () => (creds.set
      ? { jiraBaseUrl: 'https://example.atlassian.net', jiraEmail: 'me@example.com', jiraApiToken: 'token' }
      : {}),
  },
}));

const { getJiraDetail, clearJiraDetailCache, parseIssueDetail } = await import('../jiraDetailCache.js');
const { getCachedJiraMeta, clearJiraTitleCache } = await import('../jiraTitleCache.js');

const para = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const payload = {
  fields: {
    summary: 'Hover card',
    issuetype: { name: 'Story' },
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    description: para('The description'),
    comment: {
      total: 2,
      comments: [
        { author: { displayName: 'First' }, created: '2026-11-01T10:00:00.000+0000', body: para('old') },
        { author: { displayName: 'Second' }, created: '2026-11-02T10:00:00.000+0000', body: para('newest') },
      ],
    },
  },
};

let calls = 0;
function stubFetch(impl?: () => Promise<Response>) {
  vi.stubGlobal('fetch', async () => {
    calls++;
    if (impl) return impl();
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  });
}

describe('jiraDetailCache', () => {
  beforeEach(() => {
    clearJiraTitleCache();
    clearJiraDetailCache();
    creds.set = true;
    calls = 0;
    stubFetch();
  });

  it('parses the description and picks the newest comment', () => {
    const d = parseIssueDetail('CORE-1', payload);
    expect(d.meta).toEqual({ title: 'Hover card', type: 'Story', status: 'In Progress', statusCategory: 'indeterminate' });
    expect(d.description?.type).toBe('doc');
    expect(d.lastComment?.author).toBe('Second');
    expect(d.lastComment?.body?.content?.[0].content?.[0].text).toBe('newest');
    expect(d.commentCount).toBe(2);
  });

  it('handles an issue with no description and no comments', () => {
    const d = parseIssueDetail('CORE-2', { fields: { summary: 'x', description: null, comment: { comments: [], total: 0 } } });
    expect(d.description).toBeUndefined();
    expect(d.lastComment).toBeUndefined();
    expect(d.commentCount).toBe(0);
  });

  it('caches within the TTL and primes the title cache', async () => {
    const a = await getJiraDetail('CORE-1');
    const b = await getJiraDetail('CORE-1');
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toBe(1);
    expect(getCachedJiraMeta('CORE-1')?.title).toBe('Hover card');
  });

  it('de-dupes concurrent requests for the same key', async () => {
    const [a, b] = await Promise.all([getJiraDetail('CORE-1'), getJiraDetail('CORE-1')]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('reports missing credentials without fetching or caching', async () => {
    creds.set = false;
    expect(await getJiraDetail('CORE-1')).toEqual({ ok: false, reason: 'no-credentials' });
    expect(calls).toBe(0);
    creds.set = true;
    expect((await getJiraDetail('CORE-1')).ok).toBe(true);
  });

  it('maps 404 to not-found', async () => {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response));
    expect(await getJiraDetail('CORE-9')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('a hung fetch settles at the hard deadline and frees the key', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => new Promise<Response>(() => {}));
      const p = getJiraDetail('CORE-3');
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await p).toEqual({ ok: false, reason: 'error' });
      // Miss TTL (1 min) passes → a new fetch is attempted.
      stubFetch();
      await vi.advanceTimersByTimeAsync(60_001);
      expect((await getJiraDetail('CORE-3')).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
