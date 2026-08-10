import { describe, it, expect } from 'vitest';
import { mergePrRefs } from '../stateManager.js';

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

  it('keeps a pinned ref when the scanner fills the cap', () => {
    const scanned = ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5'];
    expect(mergePrRefs(undefined, scanned, undefined, ['o/r#9']))
      .toEqual(['o/r#9', 'o/r#1', 'o/r#2', 'o/r#3', 'o/r#4']);
  });

  it('caps at 5', () => {
    const many = ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5', 'o/r#6'];
    expect(mergePrRefs(many, undefined)).toHaveLength(5);
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
