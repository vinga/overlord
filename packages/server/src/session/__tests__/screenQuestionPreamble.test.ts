import { describe, it, expect } from 'vitest';
import { parseScreenQuestion } from '../permissionChecker.js';

const RULE = '─'.repeat(120);
const FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

// Verbatim shape of a live AskUserQuestion screen (Claude Code v2.1.x): the user's
// prompt, the assistant text bullet, the box rule, the header chip, the question,
// the options. The rule between the last two options is the viewport border and is
// part of the real output.
function screen(preambleLines: string[]): string {
  return [
    '',
    '❯ Ask me something with two options.                                    ',
    '  Continued prompt line.                                                ',
    '',
    ...preambleLines,
    RULE,
    ' ☐ FRUIT ',
    '',
    'Which fruit? ',
    '',
    '❯ 1. Apple',
    '     Pick apple.',
    '  2. Pear',
    '     Pick pear.',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    '',
    FOOTER,
    '',
  ].join('\n');
}

describe('parseScreenQuestion preamble', () => {
  it('captures the single-line assistant text above the menu', () => {
    const set = parseScreenQuestion(screen(['⏺ I need your input before proceeding. Please pick one below.']));
    expect(set!.preamble).toBe('I need your input before proceeding. Please pick one below.');
  });

  it('keeps multi-paragraph text, de-indenting continuation lines', () => {
    const set = parseScreenQuestion(screen([
      '⏺ I need your input.',
      '',
      '  The choice is yours.',
      '',
      '  Please pick one below.',
    ]));
    expect(set!.preamble).toBe('I need your input.\n\nThe choice is yours.\n\nPlease pick one below.');
  });

  it('handles the NBSP the TUI sometimes puts after the bullet', () => {
    const set = parseScreenQuestion(screen(['⏺\u00a0Pick one.']));
    expect(set!.preamble).toBe('Pick one.');
  });

  it('is undefined when the question box follows the prompt with no text', () => {
    const set = parseScreenQuestion(screen([]));
    expect(set).not.toBeNull();
    expect(set!.preamble).toBeUndefined();
  });

  it('never attributes a tool call to the question', () => {
    const set = parseScreenQuestion(screen([
      '⏺ Bash(git status)',
      '  ⎿  On branch main',
    ]));
    expect(set!.preamble).toBeUndefined();
  });

  it('does not reach past the user prompt for an older assistant message', () => {
    const set = parseScreenQuestion([
      '⏺ An answer from the previous turn.',
      '',
      '❯ Ask me something with two options.',
      '',
      RULE,
      ' ☐ FRUIT ',
      '',
      'Which fruit? ',
      '',
      '❯ 1. Apple',
      '  2. Pear',
      '',
      FOOTER,
    ].join('\n'));
    expect(set!.preamble).toBeUndefined();
  });

  it('still parses the question and options when a preamble is present', () => {
    const set = parseScreenQuestion(screen(['⏺ Pick one.']));
    expect(set!.questions[0].question).toBe('Which fruit?');
    expect(set!.questions[0].options.map(o => o.label)).toEqual([
      'Apple', 'Pear', 'Type something.', 'Chat about this',
    ]);
  });
});
