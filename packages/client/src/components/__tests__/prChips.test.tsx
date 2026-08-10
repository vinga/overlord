import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrChips } from '../PrChips';
import { setPrMeta } from '../../hooks/usePrMeta';

const render = (el: React.ReactElement): string => renderToStaticMarkup(el);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('PrChips', () => {
  beforeEach(() => {
    setPrMeta({});
  });

  it('renders nothing without refs', () => {
    expect(render(<PrChips refs={[]} />)).toBe('');
  });

  it('degrades to a bare chip when metadata has not resolved', () => {
    const html = render(<PrChips refs={['hypatos/prompting-service#819']} />);
    expect(text(html)).toContain('#819');
    expect(text(html)).toContain('hypatos/prompting-service');
    // Falls back to github.com so the chip is still clickable.
    expect(html).toContain('href="https://github.com/hypatos/prompting-service/pull/819"');
  });

  it('shows title and state once metadata resolves', () => {
    setPrMeta({ 'o/r#12': { title: 'Fix the thing', state: 'MERGED', url: 'https://github.com/o/r/pull/12' } });
    const html = render(<PrChips refs={['o/r#12']} />);
    expect(text(html)).toContain('Fix the thing');
    expect(html).toContain('data-state="MERGED"');
  });

  it('prefers the metadata URL so a GitHub Enterprise host survives', () => {
    setPrMeta({ 'team/svc#44': { state: 'OPEN', url: 'https://github.acme.internal/team/svc/pull/44' } });
    const html = render(<PrChips refs={['team/svc#44']} />);
    expect(html).toContain('href="https://github.acme.internal/team/svc/pull/44"');
  });

  it('reads an open draft as DRAFT, never OPEN DRAFT', () => {
    setPrMeta({ 'o/r#12': { state: 'OPEN', isDraft: true } });
    const html = render(<PrChips refs={['o/r#12']} />);
    expect(html).toContain('data-state="DRAFT"');
    expect(html).not.toContain('data-state="OPEN"');
  });

  it('offers × only when a session owns the list', () => {
    expect(render(<PrChips refs={['o/r#12']} />)).not.toContain('Dismiss');
    expect(render(<PrChips refs={['o/r#12']} sessionId="s1" />)).toContain('Dismiss o/r#12');
  });

  it('collapses past three refs behind a +N expander', () => {
    const refs = ['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4', 'o/r#5'];
    const html = render(<PrChips refs={refs} />);
    expect(text(html)).toContain('+2');
    expect(text(html)).not.toContain('#4');
  });
});
