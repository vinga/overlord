import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, parseGitPushOutput, splitBranchRef, branchRefKey } from '../pushRef.js';

describe('parseRemoteUrl', () => {
  it.each([
    ['git@github.com:o/r.git', 'o/r'],
    ['github.com:o/r.git', 'o/r'],
    ['https://github.com/o/r.git', 'o/r'],
    ['https://github.com/o/r', 'o/r'],
    ['ssh://git@ghe.corp:2222/o/r.git', 'o/r'],
    ['https://user@github.com/o/my.repo.git', 'o/my.repo'],
  ])('%s → %s', (url, repo) => {
    expect(parseRemoteUrl(url)).toBe(repo);
  });

  it.each(['/tmp/bare.git', '../other', 'https://github.com/o'])('rejects %s', (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});

describe('parseGitPushOutput', () => {
  it('reads a new branch', () => {
    const out = [
      'remote: Create a pull request for \'feat/x\' on GitHub by visiting:',
      'remote:      https://github.com/o/r/pull/new/feat/x',
      'To github.com:o/r.git',
      ' * [new branch]      feat/x -> feat/x',
      "branch 'feat/x' set up to track 'origin/feat/x'.",
    ].join('\n');
    expect(parseGitPushOutput(out)).toEqual(['o/r:feat/x']);
  });

  it('reads fast-forward and forced updates', () => {
    const out = 'To https://github.com/o/r.git\n   2fed5d4..5467e16  main -> main\n + 1a2b3c4...5d6e7f8 wip -> wip (forced update)';
    expect(parseGitPushOutput(out)).toEqual(['o/r:main', 'o/r:wip']);
  });

  it('skips rejected, deleted, tags and up-to-date', () => {
    const out = [
      'To github.com:o/r.git',
      ' ! [rejected]        main -> main (fetch first)',
      ' - [deleted]         old',
      ' * [new tag]         v1.0 -> v1.0',
      'Everything up-to-date',
    ].join('\n');
    expect(parseGitPushOutput(out)).toEqual([]);
  });

  it('strips refs/heads/ and follows several To blocks', () => {
    const out = 'To github.com:o/a.git\n * [new branch] HEAD -> refs/heads/x\nTo github.com:o/b.git\n * [new branch] y -> y';
    expect(parseGitPushOutput(out)).toEqual(['o/a:x', 'o/b:y']);
  });

  it('ignores updates under an unrecognised remote', () => {
    expect(parseGitPushOutput('To /tmp/bare.git\n * [new branch] x -> x')).toEqual([]);
  });
});

describe('splitBranchRef / branchRefKey', () => {
  it('splits at the first colon', () => {
    expect(splitBranchRef('o/r:feat:x')).toEqual({ repo: 'o/r', branch: 'feat:x' });
    expect(splitBranchRef('nocolon')).toBeNull();
  });

  it('lowercases only the repo', () => {
    expect(branchRefKey('O/R:Feat')).toBe('o/r:Feat');
  });
});
