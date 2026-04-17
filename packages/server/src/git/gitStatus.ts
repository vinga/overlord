import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
  stashCount: number;
  lastCommit: { hash: string; subject: string; author: string; relativeTime: string } | null;
  unpushedCommits: Array<{ hash: string; subject: string; relativeTime: string }>;
  pullRequest: { number: number; url: string; title: string; state: string; isDraft: boolean } | null;
}

const prCache = new Map<string, { at: number; value: GitStatus['pullRequest'] }>();
const PR_TTL_MS = 30_000;

async function run(cwd: string, args: string[], timeoutMs = 3000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
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

    const pullRequest = await readPullRequest(cwd, branch);

    return {
      branch,
      upstream,
      ahead,
      behind,
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

async function readPullRequest(cwd: string, branch: string | null): Promise<GitStatus['pullRequest']> {
  if (!branch) return null;
  const key = `${cwd}\x1f${branch}`;
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.at < PR_TTL_MS) return cached.value;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,title,state,isDraft'],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as { number: number; url: string; title: string; state: string; isDraft: boolean };
    const value = {
      number: parsed.number,
      url: parsed.url,
      title: parsed.title,
      state: parsed.state,
      isDraft: !!parsed.isDraft,
    };
    prCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // gh not installed, not authed, or no PR — treat as none
    prCache.set(key, { at: Date.now(), value: null });
    return null;
  }
}
