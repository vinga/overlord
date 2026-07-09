import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrHistoryStore } from './prHistoryStore.js';

const execFileAsync = promisify(execFile);

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
}

export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPED' | 'CANCELLED' | 'NEUTRAL';

export interface Check {
  name: string;
  state: CheckState;
  url?: string;
  elapsed?: string;
}

export interface PrFull {
  pullRequest: PrInfo | null;
  checks: Check[];
  mergeable: string | null;
  error: string | null;
}

interface CacheEntry {
  cwd: string;
  branch: string;
  value: PrInfo | null;
  checks: Check[];
  mergeable: string | null;
  error: string | null;
  rateLimited: boolean;
  fetchedAt: number;
  /** Set when checks + mergeable were last lazy-loaded via getOrFetchFull.
   *  Independent from fetchedAt (which tracks the cheap REST PR list). */
  detailsFetchedAt?: number;
  inFlight?: Promise<void>;
}

function entryKey(cwd: string, branch: string): string {
  return `${cwd}\0${branch}`;
}

const HIT_TTL_MS = 15 * 60 * 1000;        // re-check existing PR every 15 min
const MISS_TTL_MS = 30 * 60 * 1000;       // re-check absent PR every 30 min
const RATE_LIMIT_TTL_MS = 30 * 60 * 1000; // back off 30 min when GitHub rate-limits us
// A user click is explicit intent for fresh data. We only dedupe rapid
// double-clicks within this window; otherwise every tooltip open re-fetches the
// cheap PR REST lookup (core quota pool). This is what makes a just-created PR —
// or a just-merged one — appear without waiting out the background MISS/HIT TTL.
const CLICK_FRESH_MS = 10 * 1000;

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('api rate limit') || lower.includes('secondary rate limit');
}

export class PrCache {
  private entries = new Map<string, CacheEntry>();
  private onUpdate: () => void;
  // Background polling is gated by client visibility. When all clients have
  // their tab hidden, scheduleRefresh becomes a no-op so we don't burn the
  // GitHub GraphQL quota on data nobody is looking at. User-triggered fetches
  // (getOrFetchFull) bypass this gate.
  private pollingEnabled = true;
  private historyStore: PrHistoryStore | undefined;

  constructor(onUpdate: () => void, historyStore?: PrHistoryStore) {
    this.onUpdate = onUpdate;
    this.historyStore = historyStore;
  }

  setPollingEnabled(enabled: boolean): void {
    if (this.pollingEnabled === enabled) return;
    this.pollingEnabled = enabled;
  }

  /** Synchronous read. Triggers a background refresh if stale. */
  get(cwd: string, branch: string | undefined): PrInfo | null | undefined {
    if (!branch) return undefined;
    const entry = this.entries.get(entryKey(cwd, branch));
    if (!entry) {
      this.scheduleRefresh(cwd, branch);
      return undefined;
    }
    const ttl = entry.rateLimited ? RATE_LIMIT_TTL_MS : entry.value ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - entry.fetchedAt > ttl) this.scheduleRefresh(cwd, branch);
    return entry.value;
  }

  getError(cwd: string, branch: string | undefined): string | null {
    if (!branch) return null;
    const entry = this.entries.get(entryKey(cwd, branch));
    if (!entry) return null;
    // Rate-limit is a global GitHub state, not a per-room problem. Don't
    // surface it as a per-room warning — back off silently and retry later.
    if (entry.rateLimited) return null;
    return entry.error;
  }

  /**
   * Full read for the tooltip endpoint: returns PR info, checks, mergeable.
   * Awaits in-flight refresh on cache miss (OK from user-triggered endpoints).
   * User-triggered, so bypasses rate-limit backoff — a click should always
   * attempt a fresh fetch even if background polling is paused.
   */
  async getOrFetchFull(cwd: string, branch: string | undefined): Promise<PrFull> {
    const empty: PrFull = { pullRequest: null, checks: [], mergeable: null, error: null };
    if (!branch) return empty;
    const key = entryKey(cwd, branch);
    const existing = this.entries.get(key);
    const fresh = existing
      && Date.now() - existing.fetchedAt <= CLICK_FRESH_MS
      && !existing.rateLimited;
    if (!fresh) this.scheduleRefresh(cwd, branch, true);
    const entry = this.entries.get(key);
    if (entry?.inFlight) {
      try { await entry.inFlight; } catch { /* ignore */ }
    }
    const latest = this.entries.get(key);
    if (!latest) return empty;
    if (!latest.value) {
      return { pullRequest: null, checks: [], mergeable: null, error: latest.error };
    }
    // Lazy-load checks + mergeable on demand. Cache them on the entry so
    // repeat tooltip opens reuse them within HIT_TTL.
    const detailsStale = !latest.detailsFetchedAt || Date.now() - latest.detailsFetchedAt > HIT_TTL_MS;
    if (detailsStale) {
      const [checks, detail] = await Promise.all([
        fetchChecks(cwd, branch),
        fetchPrDetail(cwd, latest.value.number),
      ]);
      const updated: CacheEntry = {
        ...latest,
        checks,
        mergeable: detail.mergeable,
        detailsFetchedAt: Date.now(),
      };
      this.entries.set(key, updated);
      return { pullRequest: updated.value, checks, mergeable: detail.mergeable, error: null };
    }
    return {
      pullRequest: latest.value,
      checks: latest.checks,
      mergeable: latest.mergeable,
      error: latest.error,
    };
  }

  /** Force a one-off REST refresh for a branch that is NOT currently surfaced
   *  in the snapshot (archived/closed room). Records fresh state into
   *  prHistoryStore via the shared fetch chokepoint. Resolves when the
   *  fetch+record completes so callers can sequence calls and avoid bursting
   *  `gh` forks. The transient live-cache entry it creates is evicted by the
   *  next `retain()` (the cwd isn't in `activeCwds`). */
  async refreshForHistory(cwd: string, branch: string): Promise<void> {
    this.scheduleRefresh(cwd, branch, true);
    const inFlight = this.entries.get(entryKey(cwd, branch))?.inFlight;
    if (inFlight) {
      try { await inFlight; } catch { /* ignore — error already cached */ }
    }
  }

  retain(activeCwds: Set<string>): void {
    for (const [key, entry] of this.entries) {
      if (!activeCwds.has(entry.cwd)) this.entries.delete(key);
    }
    for (const cwd of repoIdentCache.keys()) {
      if (!activeCwds.has(cwd)) repoIdentCache.delete(cwd);
    }
  }

  private scheduleRefresh(cwd: string, branch: string, force = false): void {
    if (!this.pollingEnabled && !force) return;
    const key = entryKey(cwd, branch);
    const existing = this.entries.get(key);
    if (existing?.inFlight) return;

    const placeholder: CacheEntry = {
      cwd,
      branch,
      value: existing?.value ?? null,
      checks: existing?.checks ?? [],
      mergeable: existing?.mergeable ?? null,
      error: existing?.error ?? null,
      rateLimited: existing?.rateLimited ?? false,
      fetchedAt: existing?.fetchedAt ?? 0,
    };
    this.entries.set(key, placeholder);

    placeholder.inFlight = this.fetch(cwd, branch).then(result => {
      this.entries.set(key, {
        cwd,
        branch,
        value: result.pullRequest,
        checks: result.checks,
        mergeable: result.mergeable,
        error: result.error,
        rateLimited: !!result.error && isRateLimitError(result.error),
        fetchedAt: Date.now(),
      });
      // PR-observation chokepoint — every successful fetch flows through here,
      // so recording in this single spot covers background polls + click
      // force-refreshes uniformly.
      if (result.pullRequest && this.historyStore) {
        this.historyStore.record(cwd, branch, result.pullRequest);
      }
      this.onUpdate();
    }).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      this.entries.set(key, {
        cwd,
        branch,
        value: null,
        checks: [],
        mergeable: null,
        error: msg,
        rateLimited: isRateLimitError(msg),
        fetchedAt: Date.now(),
      });
      this.onUpdate();
    });
  }

  /** Background refresh path. Uses REST (core quota pool) and skips checks
   *  to keep the background load tiny. Checks + mergeable load on demand via
   *  `getOrFetchFull` (user opens the tooltip). */
  private async fetch(cwd: string, branch: string): Promise<PrFull> {
    const prResult = await fetchPrREST(cwd, branch);
    return { pullRequest: prResult.value, checks: [], mergeable: null, error: prResult.error };
  }
}

// repoIdent (owner/name) is derived once per cwd from `git remote get-url
// origin`. No API call. ONLY successful resolutions are cached — origin URLs
// don't change in practice, so a positive result is good for the process
// lifetime (dropped on `retain()` when cwd disappears). Failures are NOT
// cached: a transient `git` timeout during the boot spawn-storm (the event
// loop is blocked, so the 5s timer can fire) must not poison the cwd forever
// and silently blank every PR lookup for it. Uncached → the next poll retries.
const repoIdentCache = new Map<string, { owner: string; repo: string }>();

async function getRepoIdent(cwd: string): Promise<{ owner: string; repo: string } | null> {
  const cached = repoIdentCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 });
    const url = stdout.trim();
    // Match git@host:owner/repo(.git)? or https://host/owner/repo(.git)?
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) return null; // unparseable remote — don't cache, remote may change
    const ident = { owner: m[1], repo: m[2] };
    repoIdentCache.set(cwd, ident);
    return ident;
  } catch {
    // git missing/timed out/no origin — transient. Don't cache; retry next poll.
    return null;
  }
}

interface RestPull {
  number: number;
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
}

/** REST-based PR lookup (uses gh's `core` quota pool, separate from GraphQL).
 *  Returns the most recent PR for the branch — open preferred, otherwise any.
 */
async function fetchPrREST(cwd: string, branch: string): Promise<{ value: PrInfo | null; error: string | null }> {
  const ident = await getRepoIdent(cwd);
  if (!ident) return { value: null, error: null };
  try {
    // `state=all` returns open + closed; we sort by updated to pick the most recent.
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '-X', 'GET',
        '-H', 'Accept: application/vnd.github+json',
        `/repos/${ident.owner}/${ident.repo}/pulls`,
        '-f', `head=${ident.owner}:${branch}`,
        '-f', 'state=all',
        '-f', 'sort=updated',
        '-f', 'direction=desc',
        '-f', 'per_page=1',
      ],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const arr = JSON.parse(stdout) as RestPull[];
    if (arr.length === 0) return { value: null, error: null };
    const p = arr[0];
    let state = p.state.toUpperCase();
    if (state === 'CLOSED' && p.merged_at) state = 'MERGED';
    return {
      value: {
        number: p.number,
        url: p.html_url,
        title: p.title,
        state,
        isDraft: !!p.draft,
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { value: null, error: msg };
  }
}

/** Lazy fetch: PR detail (mergeable) + checks. Only called when the user
 *  opens the tooltip via getOrFetchFull. Uses GraphQL (mergeable requires it). */
async function fetchPrDetail(cwd: string, prNumber: number): Promise<{ mergeable: string | null }> {
  const ident = await getRepoIdent(cwd);
  if (!ident) return { mergeable: null };
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '-X', 'GET',
        '-H', 'Accept: application/vnd.github+json',
        `/repos/${ident.owner}/${ident.repo}/pulls/${prNumber}`,
      ],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const p = JSON.parse(stdout) as { mergeable?: boolean | null; mergeable_state?: string };
    if (p.mergeable_state) return { mergeable: p.mergeable_state.toUpperCase() };
    if (p.mergeable === true) return { mergeable: 'MERGEABLE' };
    if (p.mergeable === false) return { mergeable: 'CONFLICTING' };
    return { mergeable: null };
  } catch {
    return { mergeable: null };
  }
}

async function fetchChecks(cwd: string, branch: string): Promise<Check[]> {
  const ident = await getRepoIdent(cwd);
  if (!ident) return [];
  try {
    // REST: list check-runs for the head commit of the branch ref.
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '-X', 'GET',
        '-H', 'Accept: application/vnd.github+json',
        `/repos/${ident.owner}/${ident.repo}/commits/${encodeURIComponent(branch)}/check-runs`,
        '-f', 'per_page=50',
      ],
      { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as { check_runs?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      html_url?: string;
      started_at?: string;
      completed_at?: string;
    }> };
    return (parsed.check_runs ?? []).map(r => ({
      name: r.name,
      state: mapCheckState(r.conclusion ?? r.status ?? ''),
      url: r.html_url || undefined,
      elapsed: elapsedLabel(r.started_at, r.completed_at),
    }));
  } catch {
    return [];
  }
}

function mapCheckState(raw: string): CheckState {
  const s = raw.toUpperCase();
  if (s === 'PASS' || s === 'SUCCESS' || s === 'COMPLETED') return 'SUCCESS';
  if (s === 'FAIL' || s === 'FAILURE' || s === 'TIMED_OUT' || s === 'ACTION_REQUIRED') return 'FAILURE';
  if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'WAITING') return 'PENDING';
  if (s === 'SKIPPED' || s === 'SKIPPING') return 'SKIPPED';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  return 'NEUTRAL';
}

function elapsedLabel(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (isNaN(start)) return undefined;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

