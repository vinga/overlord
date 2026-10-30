import { describe, it, expect } from 'vitest';
import { buildWorkRows } from '../workRows';

describe('buildWorkRows', () => {
  it('is empty with nothing attached', () => {
    expect(buildWorkRows(undefined, undefined, undefined, undefined)).toEqual({ own: [], mentioned: [] });
  });

  it('splits authored from mentioned', () => {
    const { own, mentioned } = buildWorkRows(['o/a#1', 'o/b#2'], ['o/a#1'], undefined, {});
    expect(own.map(r => r.ref)).toEqual(['o/a#1']);
    expect(mentioned.map(r => r.ref)).toEqual(['o/b#2']);
  });

  it('folds a pushed branch into its authored PR', () => {
    const { own } = buildWorkRows(['o/a#1'], ['o/a#1'], ['O/A:feat'], { 'o/a#1': { headRef: 'feat', state: 'OPEN' } });
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ ref: 'o/a#1', number: 1, branch: 'feat' });
  });

  it('promotes a mentioned PR whose head branch the session pushed', () => {
    const { own, mentioned } = buildWorkRows(['o/a#5'], undefined, ['o/a:fix'], { 'o/a#5': { headRef: 'fix' } });
    expect(own.map(r => r.ref)).toEqual(['o/a#5']);
    expect(mentioned).toEqual([]);
  });

  it('keeps a branch without a PR as a bare row', () => {
    const { own } = buildWorkRows(undefined, undefined, ['o/a:wip'], {});
    expect(own).toEqual([{ repo: 'o/a', branch: 'wip' }]);
  });

  it('does not fold a same-named branch from another repo', () => {
    const { own } = buildWorkRows(['o/a#1'], ['o/a#1'], ['o/b:main'], { 'o/a#1': { headRef: 'main' } });
    expect(own.map(r => r.ref ?? `${r.repo}:${r.branch}`)).toEqual(['o/a#1', 'o/b:main']);
  });

  it('groups rows by repo in first-appearance order', () => {
    const { own } = buildWorkRows(['o/a#1', 'o/a#2'], ['o/a#1', 'o/a#2'], ['o/b:x', 'o/a:y'], {});
    expect(own.map(r => r.ref ?? `${r.repo}:${r.branch}`)).toEqual(['o/a#1', 'o/a#2', 'o/a:y', 'o/b:x']);
  });
});
