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

interface CacheEntry {
  branch: string;
  value: PrInfo | null; // null = known-no-PR
  error: string | null; // present when gh invocation errored out (not "no PR")
  fetchedAt: number;
  inFlight?: Promise<void>;
}

const HIT_TTL_MS = 60 * 1000;       // re-check existing PR every 60s
const MISS_TTL_MS = 5 * 60 * 1000;  // re-check absent PR every 5 min

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
   * Like get(), but awaits the in-flight fetch on a cache miss and always
   * returns a resolved value. Use this from user-triggered endpoints (the
   * tooltip) where it's OK to wait for the network call.
   */
  async getOrFetch(cwd: string, branch: string | undefined): Promise<PrInfo | null> {
    if (!branch) return null;
    const cached = this.get(cwd, branch);
    if (cached !== undefined) {
      // May still have an inFlight refresh running — await it for freshness.
      const entry = this.entries.get(cwd);
      if (entry?.inFlight && entry.branch === branch) {
        try { await entry.inFlight; } catch { /* ignore */ }
        const latest = this.entries.get(cwd);
        return latest?.branch === branch ? latest.value : cached;
      }
      return cached;
    }
    const entry = this.entries.get(cwd);
    if (entry?.inFlight && entry.branch === branch) {
      try { await entry.inFlight; } catch { /* ignore */ }
    }
    const latest = this.entries.get(cwd);
    return latest?.branch === branch ? latest.value : null;
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
      error: existing?.branch === branch ? existing.error : null,
      fetchedAt: existing?.branch === branch ? existing.fetchedAt : 0,
    };
    this.entries.set(cwd, placeholder);

    placeholder.inFlight = this.fetch(cwd, branch).then(result => {
      this.entries.set(cwd, {
        branch,
        value: result.value,
        error: result.error,
        fetchedAt: Date.now(),
      });
      this.onUpdate();
    }).catch(err => {
      this.entries.set(cwd, {
        branch,
        value: null,
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: Date.now(),
      });
      this.onUpdate();
    });
  }

  private async fetch(cwd: string, branch: string): Promise<{ value: PrInfo | null; error: string | null }> {
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
      // "no pull requests found" is a normal miss — not a warning condition
      if (lower.includes('no pull requests found') || lower.includes('no associated') || lower.includes('not found')) {
        return { value: null, error: null };
      }
      // ENOENT (gh not installed), auth errors, etc. — surface as warning
      return { value: null, error: msg };
    }
  }
}
