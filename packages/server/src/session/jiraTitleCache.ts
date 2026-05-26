import { globalSettingsStore } from './globalSettingsStore.js';
import type { JiraIssueMeta } from '../types.js';

const HIT_TTL_MS = 60 * 60 * 1000;   // 1h for successful fetches
const MISS_TTL_MS = 5 * 60 * 1000;   // 5m for 401/403/404/network errors
const FETCH_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 5000;

interface Entry {
  meta: JiraIssueMeta | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
let activeFetches = 0;
const queue: string[] = [];
let warnedAuth = false;

function credsReady(): { baseUrl: string; email: string; token: string } | null {
  const s = globalSettingsStore.get();
  const baseUrl = s.jiraBaseUrl?.replace(/\/+$/, '');
  if (!baseUrl || !s.jiraEmail || !s.jiraApiToken) return null;
  return { baseUrl, email: s.jiraEmail, token: s.jiraApiToken };
}

function isFresh(entry: Entry): boolean {
  const ttl = entry.meta === null ? MISS_TTL_MS : HIT_TTL_MS;
  return Date.now() - entry.fetchedAt < ttl;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function fetchOne(key: string): Promise<void> {
  const creds = credsReady();
  if (!creds) {
    cache.set(key, { meta: null, fetchedAt: Date.now() });
    return;
  }
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,status`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      if (!warnedAuth) {
        console.warn(`[jiraTitleCache] auth failed (${res.status}) for key ${key} — check jiraEmail / jiraApiToken`);
        warnedAuth = true;
      }
      cache.set(key, { meta: null, fetchedAt: Date.now() });
      return;
    }
    if (!res.ok) {
      cache.set(key, { meta: null, fetchedAt: Date.now() });
      return;
    }
    const json = (await res.json()) as {
      fields?: {
        summary?: unknown;
        issuetype?: { name?: unknown };
        status?: { name?: unknown; statusCategory?: { key?: unknown } };
      };
    };
    const f = json.fields;
    const meta: JiraIssueMeta = {
      title: str(f?.summary),
      type: str(f?.issuetype?.name),
      status: str(f?.status?.name),
      statusCategory: str(f?.status?.statusCategory?.key),
    };
    // Treat a row with no usable field as a miss (shorter TTL, keeps retrying).
    const usable = meta.title || meta.type || meta.status;
    cache.set(key, { meta: usable ? meta : null, fetchedAt: Date.now() });
  } catch {
    cache.set(key, { meta: null, fetchedAt: Date.now() });
  } finally {
    clearTimeout(timer);
  }
}

function drainQueue(): void {
  while (activeFetches < FETCH_CONCURRENCY && queue.length > 0) {
    const key = queue.shift()!;
    if (inflight.has(key)) continue;
    activeFetches++;
    const p = fetchOne(key).finally(() => {
      activeFetches--;
      inflight.delete(key);
      drainQueue();
    });
    inflight.set(key, p);
  }
}

/** Return the cached metadata for `key`, or null if not yet fetched / fetch
 *  failed. When the entry is missing or stale, schedule a background fetch — the
 *  next caller (typically the next snapshot tick) will see the fresh value. */
export function getCachedJiraMeta(key: string): JiraIssueMeta | null {
  const entry = cache.get(key);
  if (!entry || !isFresh(entry)) {
    if (credsReady() && !inflight.has(key) && !queue.includes(key)) {
      queue.push(key);
      drainQueue();
    }
    return entry?.meta ?? null;
  }
  return entry.meta;
}

/** Title-only convenience for server-side text search (live + archive). */
export function getCachedJiraTitle(key: string): string | null {
  return getCachedJiraMeta(key)?.title ?? null;
}

/** Drop the in-process cache. Called when settings change so a fresh token
 *  takes effect immediately without a server restart. */
export function clearJiraTitleCache(): void {
  cache.clear();
  warnedAuth = false;
}
