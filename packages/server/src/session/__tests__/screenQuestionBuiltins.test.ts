import { describe, it, expect } from 'vitest';
import { parseScreenQuestion } from '../permissionChecker.js';

// A representative AskUserQuestion menu as it renders in the TUI: the model's own
// options first, then the two rows the TUI appends itself.
const SCREEN = [
  '  Which session should I resume?',
  '',
  '  1. name: Yael id: e2cb8f96-0b09-46d7-a0be-933adf2045f6 ovrId: ovr-tdrojoh5',
  '  2. name: Ikazuchi id: 44516d31-1739-46db-82bb-abe800ff5e22 ovrId: ovr-xngn5od3',
  '  3. Type something',
  '  4. Chat about this',
  '',
  '  Enter to select · ↑↓ to navigate · Esc to cancel',
].join('\n');

describe('parseScreenQuestion built-in options', () => {
  it('keeps "Type something" / "Chat about this" and tags them builtin', () => {
    const set = parseScreenQuestion(SCREEN);
    expect(set).not.toBeNull();
    const opts = set!.questions[0].options;
    expect(opts.map(o => o.label)).toEqual([
      'name: Yael id: e2cb8f96-0b09-46d7-a0be-933adf2045f6 ovrId: ovr-tdrojoh5',
      'name: Ikazuchi id: 44516d31-1739-46db-82bb-abe800ff5e22 ovrId: ovr-xngn5od3',
      'Type something',
      'Chat about this',
    ]);
    expect(opts.map(o => o.builtin === true)).toEqual([false, false, true, true]);
  });

  it('keeps option order aligned with the TUI numbering (arrow-key index)', () => {
    const opts = parseScreenQuestion(SCREEN)!.questions[0].options;
    // Selecting option N in the UI sends N-1 down-arrows; that only works if the
    // parsed array index matches the on-screen number.
    expect(opts.findIndex(o => o.label === 'Type something')).toBe(2);
    expect(opts.findIndex(o => o.label === 'Chat about this')).toBe(3);
  });

  it('still extracts the question text', () => {
    expect(parseScreenQuestion(SCREEN)!.questions[0].question).toBe('Which session should I resume?');
  });
});
