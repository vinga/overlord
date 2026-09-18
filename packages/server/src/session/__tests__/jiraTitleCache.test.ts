import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../globalSettingsStore.js', () => ({
  globalSettingsStore: {
    get: () => ({
      jiraBaseUrl: 'https://example.atlassian.net',
      jiraEmail: 'me@example.com',
      jiraApiToken: 'token',
    }),
  },
}));

const { getCachedJiraMeta, invalidateJiraKeys, clearJiraTitleCache } =
  await import('../jiraTitleCache.js');

const jira = { summary: 'first summary', calls: 0 };

/** One issue payload, shaped like the /rest/api/3/issue response. */
function stubFetch() {
  vi.stubGlobal('fetch', async () => {
    jira.calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          summary: jira.summary,
          issuetype: { name: 'Bug' },
          status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        },
      }),
    } as unknown as Response;
  });
}

/** The fetch runs through a queue — let it drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('invalidateJiraKeys', () => {
  beforeEach(() => {
    clearJiraTitleCache();
    jira.summary = 'first summary';
    jira.calls = 0;
    stubFetch();
  });

  it('forces a refetch of the named key instead of serving the 1h TTL', async () => {
    expect(getCachedJiraMeta('BACKEND-1')).toBeNull();  // miss → queues
    await settle();
    expect(getCachedJiraMeta('BACKEND-1')?.title).toBe('first summary');
    expect(jira.calls).toBe(1);

    jira.summary = 'second summary';
    // Fresh entry — the TTL keeps the old title, no second call.
    expect(getCachedJiraMeta('BACKEND-1')?.title).toBe('first summary');
    expect(jira.calls).toBe(1);

    invalidateJiraKeys(['BACKEND-1']);
    expect(getCachedJiraMeta('BACKEND-1')).toBeNull();
    await settle();
    expect(getCachedJiraMeta('BACKEND-1')?.title).toBe('second summary');
    expect(jira.calls).toBe(2);
  });

  it('leaves keys it was not given alone', async () => {
    getCachedJiraMeta('BACKEND-1');
    getCachedJiraMeta('BACKEND-2');
    await settle();
    expect(jira.calls).toBe(2);

    invalidateJiraKeys(['BACKEND-2']);
    expect(getCachedJiraMeta('BACKEND-1')?.title).toBe('first summary');
    await settle();
    expect(jira.calls).toBe(2);
  });
});
