import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  branch: string;
  value: PrInfo | null;
  checks: Check[];
  mergeable: string | null;
  error: string | null;
  fetchedAt: number;
  inFlight?: Promise<void>;
}

const HIT_TTL_MS = 30 * 1000;       // re-check existing PR every 30s
const MISS_TTL_MS = 60 * 1000;      // re-check absent PR every 60s

export class PrCache {
  private entries = new Map<string, CacheEntry>();
  private onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  /** Synchronous read. Triggers a background refresh if stale. */
  get(cwd: string, branch: string | undefined): PrInfo | null | undefined {
    if (!branch) return undefined;
    const entry = this.entries.get(cwd);
    if (!entry || entry.branch !== branch) {
      this.scheduleRefresh(cwd, branch);
      return undefined;
    }
    const ttl = entry.value ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - entry.fetchedAt > ttl) this.scheduleRefresh(cwd, branch);
    return entry.value;
  }

  getError(cwd: string, branch: string | undefined): string | null {
    if (!branch) return null;
    const entry = this.entries.get(cwd);
    if (!entry || entry.branch !== branch) return null;
    return entry.error;
  }

  /**
   * Full read for the tooltip endpoint: returns PR info, checks, mergeable.
   * Awaits in-flight refresh on cache miss (OK from user-triggered endpoints).
   */
  async getOrFetchFull(cwd: string, branch: string | undefined): Promise<PrFull> {
    const empty: PrFull = { pullRequest: null, checks: [], mergeable: null, error: null };
    if (!branch) return empty;
    // Trigger refresh if missing/stale (mutates cache state).
    this.get(cwd, branch);
    const entry = this.entries.get(cwd);
    if (entry?.inFlight && entry.branch === branch) {
      try { await entry.inFlight; } catch { /* ignore */ }
    }
    const latest = this.entries.get(cwd);
    if (!latest || latest.branch !== branch) return empty;
    return {
      pullRequest: latest.value,
      checks: latest.checks,
      mergeable: latest.mergeable,
      error: latest.error,
    };
  }

  retain(activeCwds: Set<string>): void {
    for (const cwd of this.entries.keys()) {
      if (!activeCwds.has(cwd)) this.entries.delete(cwd);
    }
  }

  private scheduleRefresh(cwd: string, branch: string): void {
    const existing = this.entries.get(cwd);
    if (existing?.inFlight && existing.branch === branch) return;

    const placeholder: CacheEntry = {
      branch,
      value: existing?.branch === branch ? existing.value : null,
      checks: existing?.branch === branch ? existing.checks : [],
      mergeable: existing?.branch === branch ? existing.mergeable : null,
      error: existing?.branch === branch ? existing.error : null,
      fetchedAt: existing?.branch === branch ? existing.fetchedAt : 0,
    };
    this.entries.set(cwd, placeholder);

    placeholder.inFlight = this.fetch(cwd, branch).then(result => {
      this.entries.set(cwd, {
        branch,
        value: result.pullRequest,
        checks: result.checks,
        mergeable: result.mergeable,
        error: result.error,
        fetchedAt: Date.now(),
      });
      this.onUpdate();
    }).catch(err => {
      this.entries.set(cwd, {
        branch,
        value: null,
        checks: [],
        mergeable: null,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: Date.now(),
      });
      this.onUpdate();
    });
  }

  private async fetch(cwd: string, branch: string): Promise<PrFull> {
    // Fetch PR metadata first — if no PR, skip the checks call entirely.
    const prResult = await fetchPrView(cwd, branch);
    if (!prResult.value) {
      return { pullRequest: null, checks: [], mergeable: null, error: prResult.error };
    }
    // Fetch checks + mergeable in parallel.
    const [checks, mergeable] = await Promise.all([
      fetchChecks(cwd, branch).catch(() => []),
      fetchMergeable(cwd, branch).catch(() => null),
    ]);
    return { pullRequest: prResult.value, checks, mergeable, error: null };
  }
}

async function fetchPrView(cwd: string, branch: string): Promise<{ value: PrInfo | null; error: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,title,state,isDraft'],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const p = JSON.parse(stdout) as PrInfo;
    return {
      value: {
        number: p.number,
        url: p.url,
        title: p.title,
        state: p.state,
        isDraft: !!p.isDraft,
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('no pull requests found') || lower.includes('no associated') || lower.includes('not found')) {
      return { value: null, error: null };
    }
    return { value: null, error: msg };
  }
}

async function fetchChecks(cwd: string, branch: string): Promise<Check[]> {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'checks', branch, '--json', 'name,state,bucket,link,startedAt,completedAt'],
    { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
  );
  const raw = JSON.parse(stdout) as Array<{
    name: string;
    state?: string;
    bucket?: string;
    link?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  return raw.map(r => ({
    name: r.name,
    state: mapCheckState(r.bucket ?? r.state ?? ''),
    url: r.link || undefined,
    elapsed: elapsedLabel(r.startedAt, r.completedAt),
  }));
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

async function fetchMergeable(cwd: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'mergeable,mergeStateStatus'],
      { cwd, timeout: 5000, maxBuffer: 256 * 1024 }
    );
    const p = JSON.parse(stdout) as { mergeable?: string; mergeStateStatus?: string };
    return p.mergeStateStatus ?? p.mergeable ?? null;
  } catch {
    return null;
  }
}
