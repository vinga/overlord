import { describe, it, expect } from 'vitest';
import { parseScreenQuestion, __testing } from '../permissionChecker.js';

const { looksLikeAskUserQuestion } = __testing;

const RULE = '─'.repeat(140);

// Captured from a real TUI (Claude Code 2.1.312): a two-question AskUserQuestion,
// the first a multi-select. Apple and Banana are ticked, the caret is on Banana and
// the user has typed into the "Type something" row, which ticks it and replaces
// its label with the text.
const MULTI = [
  '❯ Ask me two questions.',
  RULE,
  '←  ☒ Fruits  ☐ Color  ✔ Submit  →',
  '',
  'Which fruits?',
  '',
  '  1. [✔] Apple',
  '         Crisp, sweet pome fruit',
  '❯ 2. [✔] Banana',
  '         Soft, starchy tropical fruit',
  '  3. [ ] Cherry',
  '         Small, round stone fruit',
  '  4. [✔] kiwi please',
  '     Next',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel',
].join('\n');

// Same set, second tab: a single-select whose "Type something" row was typed into.
const SINGLE_TYPED = [
  RULE,
  '←  ☒ Fruits  ☐ Color  ✔ Submit  →',
  '',
  'Which color?',
  '',
  '  1. Red',
  '     Warm primary color',
  '  2. Blue',
  '     Cool primary color',
  '❯ 3. green',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

const REVIEW = [
  RULE,
  '←  ☒ Pick  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● Which?',
  '   → X',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
  RULE,
].join('\n');

describe('multi-select AskUserQuestion', () => {
  const q = () => parseScreenQuestion(MULTI)!.questions[0];

  it('is flagged multiSelect with checkbox state and clean labels', () => {
    expect(q().multiSelect).toBe(true);
    expect(q().options.slice(0, 3)).toEqual([
      { label: 'Apple', checked: true, description: 'Crisp, sweet pome fruit' },
      { label: 'Banana', checked: true, description: 'Soft, starchy tropical fruit' },
      { label: 'Cherry', checked: false, description: 'Small, round stone fruit' },
    ]);
  });

  it('finds the typed-into "Type something" row by position and keeps the text', () => {
    expect(q().options[3]).toEqual({ label: 'Type something', builtin: true, freeText: true, value: 'kiwi please', checked: true });
    expect(q().options[4]).toEqual({ label: 'Chat about this', builtin: true });
  });

  it('counts the Next row when locating the caret', () => {
    expect(q().cursor).toBe(1);
    const onNext = MULTI.replace('❯ 2. [✔] Banana', '  2. [✔] Banana').replace('     Next', '❯    Next');
    expect(parseScreenQuestion(onNext)!.questions[0].cursor).toBe(4);
    const onChat = MULTI.replace('❯ 2. [✔] Banana', '  2. [✔] Banana').replace('  5. Chat about this', '❯ 5. Chat about this');
    expect(parseScreenQuestion(onChat)!.questions[0].cursor).toBe(5);
  });

  it('reads the tab bar: header and step of a ticked first tab', () => {
    const set = parseScreenQuestion(MULTI)!;
    expect(q().header).toBe('Fruits');
    expect(set.step).toEqual({ index: 0, count: 2 });
  });

  it('a lone multi-select tab chip with no arrow still anchors the box', () => {
    const set = parseScreenQuestion(MULTI.replace('←  ☒ Fruits  ☐ Color  ✔ Submit  →', '☒ Push skills  ✔ Submit  →'))!;
    expect(set.questions[0].header).toBe('Push skills');
    expect(set.step).toEqual({ index: 0, count: 1 });
    expect(set.questions[0].options).toHaveLength(5);
  });
});

describe('single-select "Type something" row', () => {
  it('is tagged freeText and keeps typed text as its value', () => {
    const set = parseScreenQuestion(SINGLE_TYPED)!;
    const opts = set.questions[0].options;
    expect(set.questions[0].multiSelect).toBe(false);
    expect(opts[2]).toEqual({ label: 'Type something', builtin: true, freeText: true, value: 'green' });
    expect(set.questions[0].cursor).toBe(2);
    expect(set.step).toEqual({ index: 1, count: 2 });
    expect(set.questions[0].header).toBe('Color');
  });
});

describe('review step', () => {
  it('is not mistaken for a question', () => {
    expect(looksLikeAskUserQuestion(REVIEW)).toBe(false);
  });
});
