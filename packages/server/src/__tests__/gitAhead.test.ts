import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { readGitAhead } from '../git/gitStatus.js';

// Real repos: a bare "remote", a clone that is behind/ahead of it, and a
// branch with no upstream.
let sandbox: string;
let clone: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'ovr-gitahead-')));
  const remote = join(sandbox, 'remote.git');
  const seed = join(sandbox, 'seed');
  clone = join(sandbox, 'clone');
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', remote);
  git(sandbox, 'clone', '-q', remote, seed);
  fs.writeFileSync(join(seed, 'a.txt'), '1');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'one');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(sandbox, 'clone', '-q', remote, clone);
  // Remote moves on by 2 commits; the clone fetches but does not merge.
  for (const n of ['2', '3']) {
    fs.writeFileSync(join(seed, 'a.txt'), n);
    git(seed, 'commit', '-qam', n);
  }
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(clone, 'fetch', '-q');
  // Clone: 1 local commit, 1 modified tracked file, 1 untracked file.
  fs.writeFileSync(join(clone, 'b.txt'), 'b');
  git(clone, 'add', 'b.txt');
  git(clone, 'commit', '-qm', 'local');
  fs.writeFileSync(join(clone, 'b.txt'), 'changed');
  fs.writeFileSync(join(clone, 'untracked.txt'), 'u');
});

afterAll(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('readGitAhead', () => {
  it('reports ahead, behind, upstream and tracked uncommitted files', async () => {
    expect(await readGitAhead(clone)).toEqual({
      branch: 'main', ahead: 1, behind: 2, upstream: 'origin/main', dirty: 1,
    });
  });

  it('reports no upstream for a local-only branch', async () => {
    git(clone, 'stash', '-q');
    git(clone, 'checkout', '-q', '-b', 'local-only');
    const info = await readGitAhead(clone);
    expect(info).toMatchObject({ branch: 'local-only', upstream: null, ahead: 0, behind: 0, dirty: 0 });
  });
});
