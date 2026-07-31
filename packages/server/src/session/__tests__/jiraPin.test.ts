import { describe, it, expect } from 'vitest';
import { mergeJiraKeys } from '../stateManager.js';

// Pinned keys are the ones the user added by hand via the `+` on an inline
// ticket key in the conversation feed. The transcript scanner never produces
// them (it only reads user-authored text), so the merge has to protect them
// from every path that would otherwise drop them.
describe('mergeJiraKeys with pinned keys', () => {
  it('keeps a pinned key when the scanner fills the cap', () => {
    const scanned = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'];
    const merged = mergeJiraKeys(undefined, scanned, undefined, ['B-9']);
    expect(merged).toEqual(['B-9', 'A-1', 'A-2', 'A-3', 'A-4']);
  });

  it('leads with pinned keys, then existing, then fresh', () => {
    const merged = mergeJiraKeys(['A-1'], ['A-2'], undefined, ['B-9']);
    expect(merged).toEqual(['B-9', 'A-1', 'A-2']);
  });

  it('does not duplicate a key that is both pinned and scanned', () => {
    const merged = mergeJiraKeys(['B-9'], ['B-9'], undefined, ['B-9']);
    expect(merged).toEqual(['B-9']);
  });

  it('re-adds a previously dismissed key once it is pinned', () => {
    // Pinning IS the un-dismiss: the dismissed filter must not apply to pins.
    const merged = mergeJiraKeys(undefined, ['B-9'], ['B-9'], ['B-9']);
    expect(merged).toEqual(['B-9']);
  });

  it('still filters dismissed keys that are not pinned', () => {
    const merged = mergeJiraKeys(['A-1'], ['A-2'], ['A-2'], ['B-9']);
    expect(merged).toEqual(['B-9', 'A-1']);
  });

  it('survives transcript truncation (existing dropped, pinned kept)', () => {
    // The truncated branch passes existing=undefined — pinned is all that is left.
    const merged = mergeJiraKeys(undefined, ['A-7'], undefined, ['B-9']);
    expect(merged).toEqual(['B-9', 'A-7']);
  });

  it('returns pinned keys even with nothing else to merge', () => {
    expect(mergeJiraKeys(undefined, undefined, undefined, ['B-9'])).toEqual(['B-9']);
  });

  it('is unchanged when there is nothing pinned', () => {
    expect(mergeJiraKeys(['A-1'], ['A-2'], ['A-3'])).toEqual(['A-1', 'A-2']);
    expect(mergeJiraKeys(undefined, undefined, undefined, undefined)).toBeUndefined();
  });
});
