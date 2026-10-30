import { describe, it, expect } from 'vitest';
import { mergePrRefs, mergeWorkRefs, PR_REFS_MAX } from '../stateManager.js';
import { prRefKey } from '../../git/prRef.js';
import { branchRefKey } from '../../git/pushRef.js';

// Same three-source merge as mergeJiraKeys — scanner proposes, `+` pins, `×`
// blocks — with one extra rule: GitHub owner/repo names are case-insensitive,
// so dedupe compares lowercased while the stored casing is whatever was written.
describe('mergePrRefs', () => {
  it('returns undefined when every source is empty', () => {
    expect(mergePrRefs(undefined, undefined, undefined, undefined)).toBeUndefined();
    expect(mergePrRefs([], [], [], [])).toBeUndefined();
  });

  it('unions existing then fresh, preserving order', () => {
    expect(mergePrRefs(['o/r#1'], ['o/r#2'])).toEqual(['o/r#1', 'o/r#2']);
  });

  it('leads with pinned refs, then existing, then fresh', () => {
    expect(mergePrRefs(['o/r#1'], ['o/r#2'], undefined, ['o/r#9']))
      .toEqual(['o/r#9', 'o/r#1', 'o/r#2']);
  });

  const refs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `o/r#${from + i}`);

  it('keeps a pinned ref when the scanner fills the cap', () => {
    expect(mergePrRefs(undefined, refs(PR_REFS_MAX), undefined, ['o/r#99']))
      .toEqual(['o/r#99', ...refs(PR_REFS_MAX - 1)]);
  });

  it(`caps at ${PR_REFS_MAX}`, () => {
    expect(mergePrRefs(refs(PR_REFS_MAX + 1), undefined)).toHaveLength(PR_REFS_MAX);
  });

  it('puts authored refs after pins, so mentions cannot crowd them out', () => {
    expect(mergePrRefs(refs(PR_REFS_MAX), undefined, undefined, ['o/r#99'], ['x/y#7']))
      .toEqual(['o/r#99', 'x/y#7', ...refs(PR_REFS_MAX - 2)]);
  });

  it('filters a dismissed authored ref', () => {
    expect(mergePrRefs(undefined, undefined, ['x/y#7'], undefined, ['x/y#7'])).toBeUndefined();
  });

  it('does not duplicate a ref that is both pinned and scanned', () => {
    expect(mergePrRefs(['o/r#9'], ['o/r#9'], undefined, ['o/r#9'])).toEqual(['o/r#9']);
  });

  it('filters dismissed refs', () => {
    expect(mergePrRefs(['o/r#1'], ['o/r#2'], ['o/r#2'])).toEqual(['o/r#1']);
  });

  it('re-adds a dismissed ref once pinned — pinning is the un-dismiss', () => {
    expect(mergePrRefs(undefined, ['o/r#9'], ['o/r#9'], ['o/r#9'])).toEqual(['o/r#9']);
  });

  it('survives transcript truncation: existing dropped, pinned kept', () => {
    // The truncated branch passes existing=undefined.
    expect(mergePrRefs(undefined, ['o/r#7'], undefined, ['o/r#9']))
      .toEqual(['o/r#9', 'o/r#7']);
  });

  it('collapses to pinned-only when /clear leaves nothing else', () => {
    expect(mergePrRefs(undefined, undefined, undefined, ['o/r#9'])).toEqual(['o/r#9']);
  });

  it('dedupes case-insensitively, keeping the first-seen casing', () => {
    expect(mergePrRefs(['Acme/Repo#7'], ['acme/repo#7'])).toEqual(['Acme/Repo#7']);
  });

  it('matches the dismissed list case-insensitively', () => {
    expect(mergePrRefs(['Acme/Repo#7'], undefined, ['acme/repo#7'])).toBeUndefined();
  });

  it('treats different repos with the same number as distinct', () => {
    expect(mergePrRefs(['a/x#12'], ['b/y#12'])).toEqual(['a/x#12', 'b/y#12']);
  });
});

describe('mergeWorkRefs', () => {
  it('returns undefined when empty', () => {
    expect(mergeWorkRefs(undefined, [], prRefKey)).toBeUndefined();
  });

  it('unions chronologically, deduped by key', () => {
    expect(mergeWorkRefs(['O/R#1'], ['o/r#1', 'o/r#2'], prRefKey)).toEqual(['O/R#1', 'o/r#2']);
  });

  it('drops the oldest past the cap of 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => `o/r:b${i}`);
    expect(mergeWorkRefs(many, undefined, branchRefKey)).toEqual(many.slice(2));
  });

  it('treats branch names case-sensitively but repos not', () => {
    expect(mergeWorkRefs(['O/R:Feat'], ['o/r:Feat', 'o/r:feat'], branchRefKey)).toEqual(['O/R:Feat', 'o/r:feat']);
  });

  it('filters dismissed refs', () => {
    expect(mergeWorkRefs(['o/r#1', 'o/r#2'], undefined, prRefKey, ['O/R#1'])).toEqual(['o/r#2']);
  });
});
