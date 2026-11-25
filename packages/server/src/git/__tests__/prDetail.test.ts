import { describe, it, expect } from 'vitest';
import { buildDetail, computeWaitingOn, latestReviews, mergeChecks } from '../prDetailCache.js';
import type { RestPull } from '../prDetailCache.js';
import type { PrCheck, PrReview } from '../../types.js';

const open = (o: Partial<RestPull> = {}): RestPull => ({ state: 'open', mergeable_state: 'clean', base: { ref: 'main' }, ...o });
const kinds = (pr: RestPull, reviews: PrReview[] = [], checks: PrCheck[] = []) => computeWaitingOn(pr, reviews, checks).map(b => b.kind);

describe('computeWaitingOn', () => {
  it('says ready when nothing blocks', () => {
    expect(computeWaitingOn(open(), [], [{ name: 'ci', state: 'passed' }])).toEqual([{ kind: 'ready', tone: 'good', text: 'Ready to merge' }]);
  });

  it('orders blockers: draft, conflicts, failing, running, changes, review, behind', () => {
    const pr = open({ draft: true, mergeable_state: 'dirty', requested_reviewers: [{ login: 'anna' }] });
    const checks: PrCheck[] = [{ name: 'lint', state: 'failed' }, { name: 'test', state: 'running' }];
    const reviews: PrReview[] = [{ user: 'bob', state: 'CHANGES_REQUESTED' }];
    expect(kinds(pr, reviews, checks)).toEqual(['draft', 'conflicts', 'checks-failed', 'checks-running', 'changes-requested', 'review']);
    expect(kinds(open({ mergeable_state: 'behind' }))).toEqual(['behind']);
  });

  it('names the checks and reviewers it waits on', () => {
    const b = computeWaitingOn(open({ requested_reviewers: [{ login: 'anna' }, { login: 'bob' }] }), [{ user: 'bob', state: 'COMMENTED' }],
      [{ name: 'a', state: 'running' }, { name: 'b', state: 'running' }]);
    expect(b.map(x => x.text)).toEqual(['2 checks running: a, b', 'Review from anna']);
  });

  it('blocked with no approval → waiting for an approving review; otherwise branch protection', () => {
    expect(kinds(open({ mergeable_state: 'blocked' }))).toEqual(['review']);
    expect(kinds(open({ mergeable_state: 'blocked' }), [{ user: 'x', state: 'APPROVED' }])).toEqual(['blocked']);
  });

  it('unknown mergeability is shown as checking', () => {
    expect(kinds(open({ mergeable_state: 'unknown' }))).toEqual(['unknown']);
  });

  it('is empty for merged and closed PRs', () => {
    expect(computeWaitingOn({ state: 'closed', draft: true }, [], [])).toEqual([]);
  });
});

describe('latestReviews', () => {
  it('keeps the latest decision per user; a later comment does not override it; dismissed drops it', () => {
    const r = latestReviews([
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'a' }, state: 'COMMENTED' },
      { user: { login: 'b' }, state: 'APPROVED' },
      { user: { login: 'b' }, state: 'DISMISSED' },
      { user: { login: 'c' }, state: 'PENDING' },
    ]);
    expect(r.map(x => [x.user, x.state])).toEqual([['a', 'APPROVED']]);
  });
});

describe('mergeChecks', () => {
  it('maps run states, lets a re-run replace the older one, and adds old-style statuses', () => {
    const c = mergeChecks(
      [
        { name: 'test', status: 'completed', conclusion: 'cancelled', completed_at: '2026-01-01T10:00:00Z' },
        { name: 'test', status: 'in_progress', started_at: '2026-01-01T11:00:00Z' },
        { name: 'lint', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T10:00:00Z' },
        { name: 'docs', status: 'completed', conclusion: 'skipped', completed_at: '2026-01-01T10:00:00Z' },
      ],
      [{ context: 'sonar', state: 'failure', updated_at: '2026-01-01T12:00:00Z' }, { context: 'sonar', state: 'success', updated_at: '2026-01-01T09:00:00Z' }],
    );
    expect(Object.fromEntries(c.map(x => [x.name, x.state]))).toEqual({ test: 'running', lint: 'passed', docs: 'skipped', sonar: 'failed' });
  });
});

describe('buildDetail', () => {
  it('reports a merged PR as MERGED with no waiting-on', () => {
    const d = buildDetail('o/r#1', { state: 'closed', merged_at: '2026-01-01T00:00:00Z', merged_by: { login: 'm' }, title: 'T', body: null }, [], [], []);
    expect(d).toMatchObject({ state: 'MERGED', mergedBy: 'm', body: '', waitingOn: [] });
  });
});
