import { credsReady, onJiraCacheClear, primeJiraMeta } from './jiraTitleCache.js';
import type { AdfNode, JiraIssueDetail, JiraIssueMeta } from '../types.js';

// Description + last comment for the ticket hover card. Fetched only on
// demand (a hover), never from the snapshot loop.

const HIT_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const DEADLINE_MS = FETCH_TIMEOUT_MS * 2;

export type DetailResult =
  | { ok: true; detail: JiraIssueDetail }
  | { ok: false; reason: 'no-credentials' | 'not-found' | 'error' };

interface Entry { result: DetailResult; fetchedAt: number }

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<DetailResult>>();

onJiraCacheClear(() => cache.clear());

export function clearJiraDetailCache(): void {
  cache.clear();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function adf(v: unknown): AdfNode | undefined {
  return v && typeof v === 'object' && typeof (v as AdfNode).type === 'string' ? (v as AdfNode) : undefined;
}

interface IssueJson {
  fields?: {
    summary?: unknown;
    issuetype?: { name?: unknown };
    status?: { name?: unknown; statusCategory?: { key?: unknown } };
    description?: unknown;
    comment?: { comments?: { author?: { displayName?: unknown }; created?: unknown; body?: unknown }[]; total?: unknown };
  };
}

/** Pure parse of the /rest/api/3/issue payload — exported for tests. */
export function parseIssueDetail(key: string, json: IssueJson): JiraIssueDetail {
  const f = json.fields;
  const meta: JiraIssueMeta = {
    title: str(f?.summary),
    type: str(f?.issuetype?.name),
    status: str(f?.status?.name),
    statusCategory: str(f?.status?.statusCategory?.key),
  };
  const comments = Array.isArray(f?.comment?.comments) ? f!.comment!.comments! : [];
  // The issue endpoint returns comments oldest first.
  const last = comments[comments.length - 1];
  const total = typeof f?.comment?.total === 'number' ? f.comment.total : comments.length;
  return {
    key,
    meta,
    description: adf(f?.description),
    lastComment: last ? { author: str(last.author?.displayName), created: str(last.created), body: adf(last.body) } : undefined,
    commentCount: total,
  };
}

async function fetchDetail(key: string): Promise<DetailResult> {
  const creds = credsReady();
  if (!creds) return { ok: false, reason: 'no-credentials' };
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,status,description,comment`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (!res.ok) {
      console.warn(`[jiraDetailCache] non-OK ${res.status} for key ${key}`);
      return { ok: false, reason: 'error' };
    }
    const detail = parseIssueDetail(key, (await res.json()) as IssueJson);
    primeJiraMeta(key, detail.meta);
    return { ok: true, detail };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.warn(`[jiraDetailCache] fetch error for ${key}: ${e?.name ?? 'Error'} ${e?.message ?? ''}`);
    return { ok: false, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Cached detail for `key`; one fetch per key at a time. An undici fetch can
 *  stay pending after abort(), so a hard deadline settles the promise anyway. */
export function getJiraDetail(key: string): Promise<DetailResult> {
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.result.ok ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - hit.fetchedAt < ttl) return Promise.resolve(hit.result);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<DetailResult>((resolve) => {
    deadline = setTimeout(() => resolve({ ok: false, reason: 'error' }), DEADLINE_MS);
  });
  const p = Promise.race([fetchDetail(key), hardStop]).then((result) => {
    // No-credentials is not cached: settings may be filled in a moment later.
    if (result.ok || result.reason !== 'no-credentials') cache.set(key, { result, fetchedAt: Date.now() });
    return result;
  }).finally(() => {
    clearTimeout(deadline);
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
