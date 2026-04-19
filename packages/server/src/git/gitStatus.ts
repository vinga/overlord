import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrCache, PrInfo } from './prCache.js';

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
  lastCommit: { hash: string; subject: string; author: string; relativeTime: string } | null;
  unpushedCommits: Array<{ hash: string; subject: string; relativeTime: string }>;
  pullRequest: PrInfo | null;
}

async function run(cwd: string, args: string[], timeoutMs = 3000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function readGitStatus(cwd: string, prCache: PrCache): Promise<GitStatus | null> {
  try {
    // porcelain v2 includes branch info + all file status lines
    const out = await run(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);

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

    // Last commit
    let lastCommit: GitStatus['lastCommit'] = null;
    try {
      const log = await run(cwd, ['log', '-1', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar']);
      const [hash, subject, author, relativeTime] = log.split('\x1f');
      if (hash) lastCommit = { hash, subject: subject ?? '', author: author ?? '', relativeTime: relativeTime ?? '' };
    } catch { /* no commits yet */ }

    // Stash count
    let stashCount = 0;
    try {
      const stash = await run(cwd, ['stash', 'list']);
      stashCount = stash.split('\n').filter(l => l.trim()).length;
    } catch { /* ignore */ }

    // Unpushed commits: upstream..HEAD if upstream is set, otherwise skip
    const unpushedCommits: GitStatus['unpushedCommits'] = [];
    if (upstream && ahead > 0) {
      try {
        const log = await run(cwd, ['log', `${upstream}..HEAD`, '-n', '15', '--pretty=format:%h%x1f%s%x1f%ar']);
        for (const line of log.split('\n')) {
          if (!line.trim()) continue;
          const [hash, subject, relativeTime] = line.split('\x1f');
          if (hash) unpushedCommits.push({ hash, subject: subject ?? '', relativeTime: relativeTime ?? '' });
        }
      } catch { /* ignore */ }
    }

    const pullRequest = await prCache.getOrFetch(cwd, branch ?? undefined);

    // Ahead/behind vs the repo's base branch (origin/main, origin/master, or
    // whatever origin/HEAD points to). Computed here so the tooltip has the
    // answer without a second roundtrip.
    let base: string | null = null;
    let baseAhead = 0;
    let baseBehind = 0;
    try {
      base = await resolveBase(cwd);
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
      unpushedCommits,
      pullRequest,
    };
  } catch {
    return null;
  }
}

async function resolveBase(cwd: string): Promise<string | null> {
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
