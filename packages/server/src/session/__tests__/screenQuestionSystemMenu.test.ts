import { describe, it, expect } from 'vitest';
import { parseScreenQuestion, __testing } from '../permissionChecker.js';

const { looksLikeAskUserQuestion, looksLikeSystemMenu, hasAskUserQuestionMarkers } = __testing;

const RULE = '─'.repeat(76);

// Verbatim screen of a session reattached after a long run: Claude raises its own
// resume-from-summary modal. It is NOT an AskUserQuestion — no ` ☐ ` chip, and the
// footer is `Enter to confirm · Esc to cancel` with no navigate hint — so the tool
// detector misses it and the choice never reaches the conversation.
const RESUME = [
  '⏺ CI all green — PR #706 is ready for human review.',
  '',
  '  - PR: https://github.com/hypatos/prompting-service/pull/706 — all checks',
  '  passed incl. integration-tests.',
  '',
  '  Lifecycle state marked complete. Nothing left on my side.',
  '',
  '✻ Churned for 17s',
  '───────────────────────────────────────── ___OVR:pty-1786130573557-gir9ib ──',
  '',
  RULE,
  '  This session is 1h 30m old and 175.1k tokens.',
  '',
  '  Resuming the full session will consume a substantial portion of your',
  '  usage limits. We recommend resuming from a summary.',
  '',
  '  ❯ 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

describe('CLI-owned resume modal', () => {
  it('is detected as a system menu, not an AskUserQuestion', () => {
    expect(looksLikeSystemMenu(RESUME)).toBe(true);
    expect(looksLikeAskUserQuestion(RESUME)).toBe(false);
  });

  it('is tagged kind: system so the client skips the built-ins and the submit step', () => {
    expect(parseScreenQuestion(RESUME)!.kind).toBe('system');
  });

  it('keeps the options in TUI order, caret row included', () => {
    // Option index drives the arrow-key injection: dropping the `❯ 1.` row would
    // make every later choice pick the one above it.
    expect(parseScreenQuestion(RESUME)!.questions[0].options).toEqual([
      { label: 'Resume from summary (recommended)' },
      { label: 'Resume full session as-is' },
      { label: "Don't ask me again" },
    ]);
  });

  it('joins the whole box into the question, lead-in line included', () => {
    // "1h 30m old and 175.1k tokens" is the number the choice turns on — a
    // last-line-only question would drop it.
    expect(parseScreenQuestion(RESUME)!.questions[0].question).toBe(
      'This session is 1h 30m old and 175.1k tokens. Resuming the full session will '
      + 'consume a substantial portion of your usage limits. We recommend resuming from a summary.',
    );
  });

  it('does not scoop the previous turn up as a preamble', () => {
    // The scrollback above the rule is already in the transcript; attributing it to
    // the modal would print it twice.
    expect(parseScreenQuestion(RESUME)!.preamble).toBeUndefined();
    expect(parseScreenQuestion(RESUME)!.questions[0].question).not.toContain('CI all green');
  });

  it('is a live menu, so a pending question is never marked stale', () => {
    expect(hasAskUserQuestionMarkers(RESUME)).toBe(true);
  });
});

describe('scrollback above the modal', () => {
  // Everything above the box rule is the previous turn, still painted on the grid.
  // Testing markers against the whole screen made an old `❯ answer the question`
  // read as a live composer and killed detection outright.
  const WITH_SCROLLBACK = [
    '❯ answer the question please',
    '',
    '⏺ Do you want to know the tricky part? Here it is.',
    '',
    '  1. First point',
    '  2. Second point',
    '',
    RULE,
    '  This session is 2d 13h old and 175.1k tokens.',
    '',
    '  Resuming the full session will consume a substantial portion of your usage limits.',
    '',
    '  ❯ 1. Resume from summary (recommended)',
    '    2. Resume full session as-is',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');

  it('is detected despite an old composer caret, prose "do you want to" and numbered prose', () => {
    expect(looksLikeSystemMenu(WITH_SCROLLBACK)).toBe(true);
  });

  it('parses only the modal box, not the scrollback', () => {
    const q = parseScreenQuestion(WITH_SCROLLBACK)!.questions[0];
    expect(q.options.map(o => o.label)).toEqual([
      'Resume from summary (recommended)',
      'Resume full session as-is',
    ]);
    expect(q.question).not.toContain('First point');
  });

  it('is rejected once the composer is back below the footer', () => {
    // Same screen, one repaint later: the modal is gone and this is stale scrollback.
    expect(looksLikeSystemMenu(WITH_SCROLLBACK + '\n\n─────────────────────\n❯ Try "write a test"')).toBe(false);
  });
});

describe('looksLikeSystemMenu guards', () => {
  it('ignores an AskUserQuestion menu — the chip claims it', () => {
    expect(looksLikeSystemMenu([
      RULE,
      ' ☐ FRUIT ',
      '',
      'Which fruit?',
      '',
      '❯ 1. Apple',
      '  2. Pear',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'))).toBe(false);
  });

  it('ignores a permission prompt', () => {
    expect(looksLikeSystemMenu([
      'Do you want to run this command?',
      '❯ 1. Yes',
      "  2. No, and tell Claude what to do differently",
      'Enter to confirm · Esc to cancel',
    ].join('\n'))).toBe(false);
  });

  it('ignores a screen whose composer is back — nothing is blocking there', () => {
    expect(looksLikeSystemMenu([
      '⏺ Steps:',
      '',
      '  ❯ 1. First',
      '    2. Second',
      '',
      'Enter to confirm · Esc to cancel',
      '─────────────────────',
      '❯ Try "write a test"',
    ].join('\n'))).toBe(false);
  });

  it('ignores a single-option confirm — nothing to choose between', () => {
    expect(looksLikeSystemMenu('❯ 1. OK\n\nEnter to confirm · Esc to cancel')).toBe(false);
  });

  it('ignores prose with no confirm footer', () => {
    expect(looksLikeSystemMenu('⏺ Steps:\n\n  ❯ 1. First\n  2. Second\n')).toBe(false);
  });
});
