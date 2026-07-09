import { describe, it, expect } from 'vitest';
import { selectArchivedPrTargets } from '../session/stateManager.js';

type Hist = Array<{ state: string; branch: string }>;

function lookup(map: Record<string, Hist>) {
  return (cwd: string): Hist => map[cwd] ?? [];
}

describe('selectArchivedPrTargets', () => {
  it('excludes active rooms (they poll on the live TTL)', () => {
    const active = new Set(['/repo/live']);
    const all = ['/repo/live', '/repo/archived'];
    const targets = selectArchivedPrTargets(active, all, lookup({
      '/repo/live': [{ state: 'OPEN', branch: 'feat-live' }],
      '/repo/archived': [{ state: 'OPEN', branch: 'feat-old' }],
    }));
    expect(targets).toEqual([{ cwd: '/repo/archived', branch: 'feat-old' }]);
  });

  it('skips MERGED entries (terminal)', () => {
    const targets = selectArchivedPrTargets(new Set(), ['/repo/a'], lookup({
      '/repo/a': [
        { state: 'MERGED', branch: 'done' },
        { state: 'OPEN', branch: 'wip' },
        { state: 'CLOSED', branch: 'abandoned' },
        { state: 'DRAFT', branch: 'draft' },
      ],
    }));
    // MERGED dropped; OPEN/CLOSED/DRAFT all still re-pollable (not merged).
    expect(targets).toEqual([
      { cwd: '/repo/a', branch: 'wip' },
      { cwd: '/repo/a', branch: 'abandoned' },
      { cwd: '/repo/a', branch: 'draft' },
    ]);
  });

  it('dedupes by cwd+branch and ignores empty branches', () => {
    const targets = selectArchivedPrTargets(new Set(), ['/repo/a'], lookup({
      '/repo/a': [
        { state: 'OPEN', branch: 'x' },
        { state: 'OPEN', branch: 'x' },
        { state: 'OPEN', branch: '' },
      ],
    }));
    expect(targets).toEqual([{ cwd: '/repo/a', branch: 'x' }]);
  });

  it('does not collide cwds that differ only by a space split', () => {
    // "/a b" + branch "c" vs "/a" + branch "b\nc"-style — newline separator
    // keeps these distinct.
    const targets = selectArchivedPrTargets(new Set(), ['/a b', '/a'], lookup({
      '/a b': [{ state: 'OPEN', branch: 'c' }],
      '/a': [{ state: 'OPEN', branch: 'c' }],
    }));
    expect(targets).toHaveLength(2);
  });

  it('returns empty when there are no candidates', () => {
    expect(selectArchivedPrTargets(new Set(['/x']), ['/x'], lookup({}))).toEqual([]);
  });
});
