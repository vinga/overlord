// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { linkifyPaths } from '../DetailPanel';

// Ticket and PR tokens in the conversation carry a copy-link icon before their `+`.
describe('inline copy-link icon', () => {
  it('is added to a PR link, ahead of its +', () => {
    const html = linkifyPaths('<p><a href="https://github.com/o/r/pull/12">https://github.com/o/r/pull/12</a></p>', false);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const a = doc.querySelector('a[data-pr-ref]')!;
    expect(a.getAttribute('data-pr-ref')).toBe('o/r#12');
    const buttons = [...a.querySelectorAll('button')].map(b => b.className);
    expect(buttons).toEqual(['inlineCopyBtn', 'prAddBtn']);
  });
});
