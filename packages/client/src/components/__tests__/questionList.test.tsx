// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionList } from '../QuestionList';
import { isQuestionText, JUMP_TO_MESSAGE_EVENT, USER_MSG_SELECTOR, type SessionQuestion } from '../../lib/questions';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const qs: SessionQuestion[] = [
  { id: '2026-11-13T11:40:00.000Z', question: 'co to jest chat tools demo?', isQuestion: true, answer: 'A test agent on dev.' },
  { id: '2026-11-13T11:43:00.000Z', question: 'czemu az 3 branche?', isQuestion: true },
];

describe('QuestionList', () => {
  it('lists newest first, shows answers or a waiting label, and counts', () => {
    act(() => root.render(<QuestionList sessionId="s1" questions={qs} starred={new Set()} loaded />));
    const rows = [...container.querySelectorAll('li')].map(li => li.textContent ?? '');
    expect(rows[0]).toContain('czemu az 3 branche?');
    expect(rows[0]).toContain('Waiting for answer');
    expect(rows[1]).toContain('A test agent on dev.');
    expect(container.textContent).toContain('All 2');
    expect(container.textContent).toContain('Starred 0');
  });

  it('Starred filter keeps only starred rows, with an empty hint otherwise', () => {
    act(() => root.render(<QuestionList sessionId="s1" questions={qs} starred={new Set([qs[0].id])} loaded />));
    const starredChip = [...container.querySelectorAll('button[role="radio"]')].find(b => b.textContent?.startsWith('Starred'))!;
    act(() => (starredChip as HTMLButtonElement).click());
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.querySelector('li')!.textContent).toContain('chat tools demo');
  });

  it('a row click dispatches the jump event; the star PUTs', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ questions: qs, starred: [qs[1].id] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: unknown[] = [];
    const onJump = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(JUMP_TO_MESSAGE_EVENT, onJump);
    act(() => root.render(<QuestionList sessionId="s1" questions={qs} starred={new Set()} loaded />));
    act(() => (container.querySelector('li button') as HTMLButtonElement).click());
    window.removeEventListener(JUMP_TO_MESSAGE_EVENT, onJump);
    expect(seen).toEqual([{ sessionId: 's1', id: qs[1].id }]);

    act(() => (container.querySelector('li button[aria-pressed]') as HTMLButtonElement).click());
    const put = fetchMock.mock.calls.find(c => String((c as unknown[])[0]).endsWith('/questions/star')) as unknown[] | undefined;
    expect(put).toBeDefined();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ id: qs[1].id, starred: true });
  });
});

describe('question markers', () => {
  it('isQuestionText ignores ? in code, URLs and pasted paths', () => {
    expect(isQuestionText('why?')).toBe(true);
    expect(isQuestionText('see `a?b`')).toBe(false);
    expect(isQuestionText('https://x.io/?q=1')).toBe(false);
    expect(isQuestionText('@/var/x?.jpg')).toBe(false);
  });

  it('questions-mode selector matches questions and starred messages only', () => {
    container.innerHTML = `
      <div data-user-msg="a" data-user-question="1"></div>
      <div data-user-msg="b"></div>
      <div data-user-msg="c" data-user-starred="1"></div>`;
    const keys = [...container.querySelectorAll(USER_MSG_SELECTOR.questions)].map(e => e.getAttribute('data-user-msg'));
    expect(keys).toEqual(['a', 'c']);
    expect(container.querySelectorAll(USER_MSG_SELECTOR.all)).toHaveLength(3);
  });
});
