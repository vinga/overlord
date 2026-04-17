import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AheadBehind {
  ahead: number;
  behind: number;
  base: string | null; // e.g. "origin/main", null if no base could be resolved
}

interface Entry {
  branch: string;
  value: AheadBehind | null;
  error: string | null;
  fetchedAt: number;
  inFlight?: Promise<void>;
}

const TTL_MS = 30 * 1000;

export class AheadBehindCache {
  private entries = new Map<string, Entry>();
  private onUpdate: () => void;

  constructor(onUpdate: () => void) {
    this.onUpdate = onUpdate;
  }

  get(cwd: string, branch: string | undefined): AheadBehind | null | undefined {
    if (!branch) return undefined;
    const entry = this.entries.get(cwd);
    if (!entry || entry.branch !== branch) {
      this.scheduleRefresh(cwd, branch);
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > TTL_MS) this.scheduleRefresh(cwd, branch);
    return entry.value;
  }

  getError(cwd: string, branch: string | undefined): string | null {
    if (!branch) return null;
    const entry = this.entries.get(cwd);
    if (!entry || entry.branch !== branch) return null;
    return entry.error;
  }

  retain(activeCwds: Set<string>): void {
    for (const cwd of this.entries.keys()) {
      if (!activeCwds.has(cwd)) this.entries.delete(cwd);
    }
  }

  private scheduleRefresh(cwd: string, branch: string): void {
    const existing = this.entries.get(cwd);
    if (existing?.inFlight && existing.branch === branch) return;

    const placeholder: Entry = {
      branch,
      value: existing?.branch === branch ? existing.value : null,
      error: existing?.branch === branch ? existing.error : null,
      fetchedAt: existing?.branch === branch ? existing.fetchedAt : 0,
    };
    this.entries.set(cwd, placeholder);

    placeholder.inFlight = this.fetch(cwd).then(result => {
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

  private async fetch(cwd: string): Promise<{ value: AheadBehind | null; error: string | null }> {
    const baseResult = await resolveBase(cwd);
    if (baseResult.error) {
      return { value: null, error: baseResult.error };
    }
    const base = baseResult.base;
    if (!base) return { value: { ahead: 0, behind: 0, base: null }, error: null };
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--left-right', '--count', `${base}...HEAD`],
        { cwd, timeout: 3000, maxBuffer: 1024 * 1024 }
      );
      const m = stdout.trim().match(/^(\d+)\s+(\d+)/);
      if (!m) return { value: { ahead: 0, behind: 0, base }, error: null };
      return { value: { behind: parseInt(m[1], 10), ahead: parseInt(m[2], 10), base }, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { value: null, error: `git rev-list ${base}...HEAD failed: ${msg}` };
    }
  }
}

async function resolveBase(cwd: string): Promise<{ base: string | null; error: string | null }> {
  const opts = { cwd, timeout: 2000, maxBuffer: 1024 * 1024 };
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], opts);
    const m = stdout.trim().match(/^refs\/remotes\/(.+)$/);
    if (m) return { base: m[1], error: null };
  } catch { /* not set; fall through */ }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', candidate], opts);
      return { base: candidate, error: null };
    } catch { /* next */ }
  }
  return { base: null, error: null };  // no base found, not an error
}
