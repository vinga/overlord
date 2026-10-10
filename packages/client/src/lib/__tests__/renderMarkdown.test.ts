// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../renderMarkdown';

describe('renderMarkdown', () => {
  it('strips event-handler attributes from raw HTML', () => {
    const html = renderMarkdown('hello <img src=x onerror=alert(1)>');
    expect(html).toContain('<img');
    expect(html).not.toMatch(/onerror/i);
  });

  it('strips script tags', () => {
    const html = renderMarkdown('# t\n\n<script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('alert(1)');
  });

  it('drops javascript: links', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('keeps target=_blank on links', () => {
    const html = renderMarkdown('[site](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://example.com"');
  });
});
