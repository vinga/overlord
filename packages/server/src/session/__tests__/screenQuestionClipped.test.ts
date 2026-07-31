import { describe, it, expect } from 'vitest';
import { parseScreenQuestion, __testing } from '../permissionChecker.js';

const { looksLikeAskUserQuestion, hasAskUserQuestionMarkers } = __testing;

const RULE = '─'.repeat(140);

// Verbatim tail of a real session ("PS-B Enforce externals model rung"): the answer
// is long enough that the box overflows the viewport, so the TUI drops the
// `Enter to select · ↑/↓ to navigate · Esc to cancel` footer and shows a
// "Jump to bottom" rule instead. The assistant's prose above the box includes a
// markdown table AND a numbered list — both traps for a naive option scan.
const CLIPPED = [
  '  │ both deployed     │ Still nothing changes — the rung only bites when a model row is ADDING_DISABLED_FOR_EXTERNALS.  │',
  '  └───────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────┘',
  '  ',
  '  Two things follow:',
  '  ',
  '  1. The DB column is already the real kill switch.',
  '  2. A per-company flag is the only way to carve out an exemption.',
  RULE,
  ' ☐ Flag y/n ',
  '',
  'Given that: flag or no flag?',
  '',
  '❯ 1. No flag (Recommended)',
  '     The model row + isExternal param are already two independent gates.',
  '  2. Mirror Sylwester — flag, default OFF, per company',
  '     Ships dark; you enable it globally or per company in Flagsmith.',
  '  3. Flag, default ON',
  "     Diverges from Sylwester's default-off convention.",
  // The scroll indicator is painted over the right of the last visible row, so it
  // shares the line with option 4 — and option 5 never makes it onto the screen.
  '  4. Type something.                                    Jump to bottom (click) ↓ ',
].join('\n');

describe('AskUserQuestion menu taller than the viewport', () => {
  it('is still detected without the footer triad', () => {
    expect(looksLikeAskUserQuestion(CLIPPED)).toBe(true);
  });

  it('parses the question, header and options', () => {
    const set = parseScreenQuestion(CLIPPED);
    expect(set).not.toBeNull();
    expect(set!.questions[0].question).toBe('Given that: flag or no flag?');
    expect(set!.questions[0].header).toBe('Flag y/n');
    expect(set!.questions[0].options.map(o => o.label)).toEqual([
      'No flag (Recommended)',
      // Labels are ASCII-stripped for presentation; the em-dash goes with it.
      'Mirror Sylwester  flag, default OFF, per company',
      'Flag, default ON',
      'Type something.',
    ]);
  });

  it('ignores numbered lines in the prose above the box', () => {
    // "1. The DB column…" / "2. A per-company flag…" sit above the header chip. If
    // they were parsed as options every index would shift and clicking option N
    // would send N-1 arrows to the wrong row.
    const opts = parseScreenQuestion(CLIPPED)!.questions[0].options;
    expect(opts.length).toBe(4);
    expect(opts[0].label).toBe('No flag (Recommended)');
    expect(opts[3].builtin).toBe(true);
  });

  it('keeps the option the scroll indicator is painted over, without its text', () => {
    const opts = parseScreenQuestion(CLIPPED)!.questions[0].options;
    // Dropping this row would also drop the "Chat about this" that follows it, and
    // "Type something" is the row a user reaches for when the menu is unreadable.
    expect(opts[3]).toEqual({ label: 'Type something.', builtin: true });
  });

  it('leaves the preamble undefined when the message is scrolled off screen', () => {
    // Better nothing than a fragment starting mid-table.
    expect(parseScreenQuestion(CLIPPED)!.preamble).toBeUndefined();
  });

  it('keeps a preamble that contains a markdown table', () => {
    const set = parseScreenQuestion([
      '❯ Should we ship it?',
      '',
      '⏺ Here is the trade-off:',
      '  ',
      '  ┌──────┬──────┐',
      '  │ a    │ b    │',
      '  └──────┴──────┘',
      RULE,
      ' ☐ SHIP ',
      '',
      'Ship it?',
      '',
      '❯ 1. Yes',
      '  2. No',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n'));
    expect(set!.preamble).toContain('Here is the trade-off:');
    expect(set!.preamble).toContain('│ a    │ b    │');
  });
});

describe('hasAskUserQuestionMarkers', () => {
  it('sees the clipped menu, so it is never declared stale', () => {
    expect(hasAskUserQuestionMarkers(CLIPPED)).toBe(true);
  });

  it('is false for an ordinary composer screen', () => {
    expect(hasAskUserQuestionMarkers([
      '⏺ Done.',
      '',
      '─────────────────────',
      '❯ Try "write a test"',
      '─────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n'))).toBe(false);
  });

  it('is false for a numbered list with no menu markers', () => {
    expect(hasAskUserQuestionMarkers('⏺ Steps:\n\n  1. First\n  2. Second\n')).toBe(false);
  });
});

describe('looksLikeAskUserQuestion guards', () => {
  it('rejects a permission prompt', () => {
    expect(looksLikeAskUserQuestion([
      'Do you want to run this command?',
      ' ☐ Bash ',
      '❯ 1. Yes',
      '  2. No',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n'))).toBe(false);
  });

  it('rejects a numbered picker with no chip and no footer', () => {
    expect(looksLikeAskUserQuestion('❯ 1. sonnet\n  2. opus\n  3. haiku\n')).toBe(false);
  });
});
