import React from 'react';
import type { ActivityItem } from '../types';

export interface SearchMatch {
  item: ActivityItem;
  excerpt: string;
  boldRanges: [number, number][];
}

export function buildCorpus(item: ActivityItem): string {
  if (item.kind === 'thinking' && item.isRedacted) return '';
  const parts: string[] = [item.content];
  if (item.inputJson) parts.push(item.inputJson);
  if (item.resultJson) parts.push(item.resultJson);
  return parts.join(' ');
}

export function makeExcerpt(
  corpus: string,
  query: string,
  windowSize = 120,
): { text: string; start: number; end: number } {
  const lower = corpus.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return { text: corpus.slice(0, windowSize), start: -1, end: -1 };
  const half = Math.floor(windowSize / 2);
  const from = Math.max(0, idx - half + Math.floor(query.length / 2));
  const to = Math.min(corpus.length, from + windowSize);
  const adjusted = Math.max(0, to - windowSize);
  const text = (adjusted > 0 ? '…' : '') + corpus.slice(adjusted, to) + (to < corpus.length ? '…' : '');
  const matchInExcerpt = idx - adjusted + (adjusted > 0 ? 1 : 0);
  return { text, start: matchInExcerpt, end: matchInExcerpt + query.length };
}

export function searchFeed(feed: ActivityItem[], query: string): SearchMatch[] {
  const q = query.toLowerCase();
  return feed
    .filter(item => buildCorpus(item).toLowerCase().includes(q))
    .map(item => {
      const corpus = buildCorpus(item);
      const { text, start, end } = makeExcerpt(corpus, query);
      return { item, excerpt: text, boldRanges: start >= 0 ? [[start, end] as [number, number]] : [] };
    });
}

export function BoldExcerpt({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(<strong key={s}>{text.slice(s, e)}</strong>);
    cursor = e;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
