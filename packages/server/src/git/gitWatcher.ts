import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';

type Listener = (cwd: string, branch: string | undefined) => void;

interface Entry {
  watcher: FSWatcher;
  headPath: string;
  branch: string | undefined;
}

/**
 * Watches `.git/HEAD` for each room cwd and notifies when the branch changes.
 * Supports plain repos (cwd/.git/HEAD) and worktrees (cwd/.git file → gitdir HEAD).
 */
export class GitWatcher {
  private entries = new Map<string, Entry>();
  private listener: Listener;

  constructor(listener: Listener) {
    this.listener = listener;
  }

  /** Idempotent. Returns branch name if the cwd is a git repo, otherwise undefined. */
  watch(cwd: string): string | undefined {
    const existing = this.entries.get(cwd);
    if (existing) return existing.branch;

    const headPath = resolveHeadPath(cwd);
    if (!headPath) return undefined;

    const branch = readBranchFromHead(headPath);
    const watcher = chokidar.watch(headPath, { persistent: true, ignoreInitial: true });
    watcher.on('change', () => {
      const entry = this.entries.get(cwd);
      if (!entry) return;
      const newBranch = readBranchFromHead(entry.headPath);
      if (newBranch !== entry.branch) {
        entry.branch = newBranch;
        this.listener(cwd, newBranch);
      }
    });
    watcher.on('error', () => { /* ignore */ });

    this.entries.set(cwd, { watcher, headPath, branch });
    return branch;
  }

  getBranch(cwd: string): string | undefined {
    return this.entries.get(cwd)?.branch;
  }

  /** Stop watching cwds no longer in use. */
  retain(activeCwds: Set<string>): void {
    for (const [cwd, entry] of this.entries) {
      if (!activeCwds.has(cwd)) {
        entry.watcher.close().catch(() => {});
        this.entries.delete(cwd);
      }
    }
  }

  close(): void {
    for (const { watcher } of this.entries.values()) watcher.close().catch(() => {});
    this.entries.clear();
  }
}

function resolveHeadPath(cwd: string): string | undefined {
  const dotGit = path.join(cwd, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return path.join(dotGit, 'HEAD');
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return undefined;
      const rel = m[1].trim();
      const gitDir = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
      return path.join(gitDir, 'HEAD');
    }
  } catch { /* not a repo */ }
  return undefined;
}

function readBranchFromHead(headPath: string): string | undefined {
  try {
    const content = fs.readFileSync(headPath, 'utf8').trim();
    const m = content.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1].trim();
    if (/^[0-9a-f]{7,40}$/i.test(content)) return content.slice(0, 7);
    return undefined;
  } catch {
    return undefined;
  }
}
