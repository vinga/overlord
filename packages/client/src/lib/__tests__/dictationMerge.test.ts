import { describe, expect, it } from 'vitest';
import { heardSince, mergeDictation } from '../dictationStore';

describe('mergeDictation', () => {
  it('passes the transcript through when the composer was not edited', () => {
    expect(mergeDictation(null, 'fix the bug')).toBe('fix the bug');
  });

  it('keeps deleted text deleted and appends only new words', () => {
    const edit = { base: '', heardAt: 'old sentence here' };
    expect(mergeDictation(edit, 'old sentence here')).toBe('');
    expect(mergeDictation(edit, 'old sentence here new words')).toBe('new words');
  });

  it('appends after a partially edited draft', () => {
    const edit = { base: 'old sentence', heardAt: 'old sentence here' };
    expect(mergeDictation(edit, 'old sentence here and more')).toBe('old sentence and more');
  });

  it('does not double a trailing space in the base', () => {
    expect(mergeDictation({ base: 'hi ', heardAt: 'a' }, 'a b')).toBe('hi b');
  });
});

describe('heardSince', () => {
  it('cuts by word count when the engine revised earlier words', () => {
    expect(heardSince('I got stuck there now', 'I go stuck there')).toBe('now');
  });

  it('returns empty when the final text is shorter than the edit point', () => {
    expect(heardSince('fix it', 'fix it go')).toBe('');
  });
});
