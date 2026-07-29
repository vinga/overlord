import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrCache } from './prCache.js';

const execFileAsync = promisify(execFile);

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base: string | null;
  baseAhead: number;
  baseBehind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
  stashCount: number;
  lastCommit: { hash: string; subject: string; author: string; relativeTime: string; filesChanged: number } | null;
  branchCommits: Array<{ hash: string; subject: string; relativeTime: string; filesChanged: number; pushed: boolean }>;
  modifiedCount: number;
  addedCount: number;
}

async function run(cwd: string, args: string[], timeoutMs = 3000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** Ahead-count only, in ONE spawn.
 *
 *  `readGitStatus` costs 8–10 `git` subprocesses, one of which walks the entire
 *  working tree (`--untracked-files=all`). The 30s ahead-sweep needs exactly two
 *  fields out of that, so it gets its own query: no working-tree walk, no log,
 *  no stash, no base resolution. On a 12-room server this is the difference
 *  between ~110 spawns per sweep and 12 — `posix_spawn` on the main thread was
 *  10.9% of server CPU and the dominant source of PTY stalls. */
export async function readGitAhead(cwd: string): Promise<{ branch: string | null; ahead: number } | null> {
  try {
    const out = await run(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '--no-renames'], 3000);
    let branch: string | null = null;
    let ahead = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const h = line.slice('# branch.head '.length).trim();
        branch = h === '(detached)' ? null : h;
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) ahead = parseInt(m[1], 10);
      } else if (!line.startsWith('# ')) {
        // Header block is emitted first; everything after it is file status we
        // don't need. Stop scanning rather than walking the whole output.
        break;
      }
    }
    return { branch, ahead };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/not a git repository/i.test(msg)) return null;
    return null;
  }
}

export async function readGitStatus(cwd: string, prCache: PrCache): Promise<GitStatus | null> {
  try {
    // porcelain v2 includes branch info + all file status lines
    const out = await run(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], 5000);

    // Resolved once and reused by both the branch-commits range and the
    // ahead/behind-vs-base pass below — this used to fork twice per call.
    const baseRef = await resolveBase(cwd);

    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];

    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const h = line.slice('# branch.head '.length).trim();
        branch = h === '(detached)' ? null : h;
      } else if (line.startsWith('# branch.upstream ')) {
        upstream = line.slice('# branch.upstream '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // 2 has an extra '<X><score>' field before path and a tab
        const parts = line.split(' ');
        const xy = parts[1] ?? '';
        const pathStr = line.startsWith('2 ')
          ? (line.split('\t')[0] ?? '').split(' ').slice(9).join(' ')
          : parts.slice(8).join(' ');
        const staged_ = xy[0] !== '.' && xy[0] !== undefined;
        const unstaged = xy[1] !== '.' && xy[1] !== undefined;
        if (staged_) staged.push(pathStr);
        if (unstaged) modified.push(pathStr);
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        conflicted.push(parts.slice(10).join(' '));
      } else if (line.startsWith('? ')) {
        untracked.push(line.slice(2));
      }
    }

    // Last commit (filesChanged filled by branch-commits pass below)
    let lastCommit: GitStatus['lastCommit'] = null;
    try {
      const log = await run(cwd, ['log', '-1', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar']);
      const [hash, subject, author, relativeTime] = log.split('\x1f');
      if (hash) {
        lastCommit = { hash, subject: subject ?? '', author: author ?? '', relativeTime: relativeTime ?? '', filesChanged: 0 };
      }
    } catch { /* no commits yet */ }

    // Stash count
    let stashCount = 0;
    try {
      const stash = await run(cwd, ['stash', 'list']);
      stashCount = stash.split('\n').filter(l => l.trim()).length;
    } catch { /* ignore */ }

    // Branch commits — use base if known, else upstream, else last 20.
    // Single `git log --shortstat` call: fetches hash/subject/time AND files-changed in one pass.
    const branchCommits: GitStatus['branchCommits'] = [];
    try {
      const range = baseRef ? `${baseRef}..HEAD` : upstream ? `${upstream}..HEAD` : 'HEAD';
      const limit = baseRef || upstream ? 50 : 20;
      const args = baseRef || upstream
        ? ['log', range, '-n', String(limit), '--pretty=format:__CMT__%x1f%h%x1f%s%x1f%ar', '--shortstat']
        : ['log', '-n', String(limit), '--pretty=format:__CMT__%x1f%h%x1f%s%x1f%ar', '--shortstat'];
      const log = await run(cwd, args, 4000);
      const rawCommits: Array<{ hash: string; subject: string; relativeTime: string; filesChanged: number }> = [];
      let cur: { hash: string; subject: string; relativeTime: string; filesChanged: number } | null = null;
      for (const line of log.split('\n')) {
        if (line.startsWith('__CMT__')) {
          if (cur) rawCommits.push(cur);
          const [, hash, subject, relativeTime] = line.split('\x1f');
          cur = { hash: hash ?? '', subject: subject ?? '', relativeTime: relativeTime ?? '', filesChanged: 0 };
        } else if (cur) {
          // shortstat line: " N files changed, M insertions(+), K deletions(-)"
          const m = line.match(/(\d+)\s+files?\s+changed/);
          if (m) cur.filesChanged = parseInt(m[1], 10);
        }
      }
      if (cur) rawCommits.push(cur);
      // Unpushed hashes — commits not reachable from upstream
      const unpushedSet = new Set<string>();
      if (upstream) {
        try {
          const up = await run(cwd, ['rev-list', `${upstream}..HEAD`, '--abbrev-commit'], 2000);
          up.split('\n').forEach(h => { const t = h.trim(); if (t) unpushedSet.add(t); });
        } catch { /* ignore */ }
      } else {
        rawCommits.forEach(c => unpushedSet.add(c.hash));
      }
      rawCommits.forEach(c => branchCommits.push({
        ...c,
        pushed: !unpushedSet.has(c.hash),
      }));
      // Backfill lastCommit.filesChanged from first row (HEAD).
      if (lastCommit && rawCommits.length > 0 && rawCommits[0].hash === lastCommit.hash) {
        lastCommit.filesChanged = rawCommits[0].filesChanged;
      }
    } catch { /* ignore */ }

    // Warm the PR cache (non-blocking) so /api/git/pr has fresh data.
    prCache.get(cwd, branch ?? undefined);

    // Ahead/behind vs the repo's base branch (origin/main, origin/master, or
    // whatever origin/HEAD points to). Computed here so the tooltip has the
    // answer without a second roundtrip.
    const base: string | null = baseRef;
    let baseAhead = 0;
    let baseBehind = 0;
    try {
      if (base) {
        const ab = await run(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
        const m = ab.trim().match(/^(\d+)\s+(\d+)/);
        if (m) { baseBehind = parseInt(m[1], 10); baseAhead = parseInt(m[2], 10); }
      }
    } catch { /* ignore */ }

    return {
      branch,
      upstream,
      ahead,
      behind,
      base,
      baseAhead,
      baseBehind,
      staged,
      modified,
      untracked,
      conflicted,
      stashCount,
      lastCommit,
      branchCommits,
      modifiedCount: staged.length + modified.length,
      addedCount: untracked.length,
    };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // Non-git directories are expected; don't log as an error.
    if (/not a git repository/i.test(msg)) return null;
    console.error('[gitStatus] failed', cwd, msg);
    return null;
  }
}

/** `origin/HEAD` does not move minute to minute, but resolving it costs up to 3
 *  spawns (symbolic-ref, then rev-parse per candidate) and `readGitStatus` used
 *  to call it twice per invocation. Memoized on a 10-minute TTL; a miss is the
 *  only case that forks. Negative results are cached too — a repo with no origin
 *  is exactly the case that pays the full 3-spawn price on every call. */
const baseCache = new Map<string, { base: string | null; at: number }>();
const BASE_TTL_MS = 10 * 60 * 1000;

async function resolveBase(cwd: string): Promise<string | null> {
  const hit = baseCache.get(cwd);
  if (hit && Date.now() - hit.at < BASE_TTL_MS) return hit.base;
  const base = await resolveBaseUncached(cwd);
  baseCache.set(cwd, { base, at: Date.now() });
  return base;
}

async function resolveBaseUncached(cwd: string): Promise<string | null> {
  try {
    const out = await run(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'], 2000);
    const m = out.trim().match(/^refs\/remotes\/(.+)$/);
    if (m) return m[1];
  } catch { /* not set */ }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await run(cwd, ['rev-parse', '--verify', '--quiet', candidate], 2000);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}
