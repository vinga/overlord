import { describe, it, expect } from 'vitest';
import {
  parseTitleSentinel,
  nextNameForTitle,
  shouldApplyTitleOnInsert,
  titleStampForRename,
} from '../stateManager.js';

const wrap = (body: string) => `<<overlord:title>>${body}<</overlord:title>>`;

describe('parseTitleSentinel', () => {
  it('extracts and trims the body', () => {
    expect(parseTitleSentinel(wrap('  Fix the thing  '))).toBe('Fix the thing');
  });

  it('finds the block inside surrounding prose', () => {
    expect(parseTitleSentinel(`ok, renaming.\n${wrap('Renamed')}\ndone`)).toBe('Renamed');
  });

  it('spans newlines inside the body', () => {
    expect(parseTitleSentinel(wrap('line one\nline two'))).toBe('line one\nline two');
  });

  it('caps at 80 chars', () => {
    const title = parseTitleSentinel(wrap('x'.repeat(200)));
    expect(title).toHaveLength(80);
  });

  it('returns undefined for absent / empty / undefined input', () => {
    expect(parseTitleSentinel(undefined)).toBeUndefined();
    expect(parseTitleSentinel('no sentinel here')).toBeUndefined();
    expect(parseTitleSentinel(wrap('   '))).toBeUndefined();
  });

  // The documented common mistake: the opening tag used on both ends. The regex
  // must NOT match, so the rename fails loudly rather than setting a junk name.
  it('rejects the opening tag used as the closing tag', () => {
    expect(parseTitleSentinel('<<overlord:title>>Nope<<overlord:title>>')).toBeUndefined();
  });

  it('takes the first block when several are present', () => {
    expect(parseTitleSentinel(`${wrap('first')} ${wrap('second')}`)).toBe('first');
  });
});

describe('nextNameForTitle', () => {
  it('replaces a spawn-pool name outright', () => {
    expect(nextNameForTitle('Simone', 'BACKEND-2459 Verify')).toBe('BACKEND-2459 Verify');
  });

  it('preserves a short uppercase grouping prefix', () => {
    expect(nextNameForTitle('OV old topic', 'new topic')).toBe('OV new topic');
    expect(nextNameForTitle('PS-B old topic', 'new topic')).toBe('PS-B new topic');
  });

  it('does not treat a long uppercase run or a capitalised word as a prefix', () => {
    expect(nextNameForTitle('TOOLONGPREFIX old', 'new')).toBe('new');
    expect(nextNameForTitle('Simone old topic', 'new')).toBe('new');
  });

  it('handles an unnamed record', () => {
    expect(nextNameForTitle(undefined, 'new')).toBe('new');
  });
});

describe('shouldApplyTitleOnInsert', () => {
  // The ovr-hzs1ez74 case: worker adopted a closed session whose transcript
  // carries a sentinel that was consumed by a different (now archived) record.
  it('applies when the record has a sentinel in lastMessage but none stamped', () => {
    expect(shouldApplyTitleOnInsert({}, wrap('BACKEND-2459 Verify'))).toBe(true);
  });

  it('is a no-op once titleSentinel is stamped — repeat inserts do not re-rename', () => {
    expect(shouldApplyTitleOnInsert({ titleSentinel: 'anything' }, wrap('BACKEND-2459'))).toBe(false);
  });

  it('is a no-op without a sentinel, or without a record', () => {
    expect(shouldApplyTitleOnInsert({}, 'just a normal reply')).toBe(false);
    expect(shouldApplyTitleOnInsert({}, undefined)).toBe(false);
    expect(shouldApplyTitleOnInsert(undefined, wrap('title'))).toBe(false);
  });
});

describe('titleStampForRename', () => {
  // Without this, a hand-typed name would be reverted by the insert path on the
  // next boot, using a sentinel still sitting in the transcript.
  it('stamps an unconsumed sentinel so a manual rename survives', () => {
    expect(titleStampForRename({ lastMessage: wrap('Stale title') }))
      .toEqual({ titleSentinel: 'Stale title' });
  });

  it('stamps nothing when there is no sentinel to consume', () => {
    expect(titleStampForRename({ lastMessage: 'plain reply' })).toBeUndefined();
    expect(titleStampForRename({})).toBeUndefined();
  });

  it('stamps nothing when the sentinel is already consumed', () => {
    expect(titleStampForRename({ lastMessage: wrap('Same'), titleSentinel: 'Same' })).toBeUndefined();
  });

  // Rename → insert → rename must stay stable: after the stamp, the insert path
  // declines, so the user's name is never overwritten.
  it('composes with shouldApplyTitleOnInsert to block the revive', () => {
    const rec: { titleSentinel?: string; lastMessage?: string } = { lastMessage: wrap('Stale title') };
    expect(shouldApplyTitleOnInsert(rec, rec.lastMessage)).toBe(true);
    Object.assign(rec, titleStampForRename(rec));
    expect(shouldApplyTitleOnInsert(rec, rec.lastMessage)).toBe(false);
  });
});
