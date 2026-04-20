import { marked } from 'marked';

const markdownCache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(text || '', { breaks: true, async: false }) as string;
  if (markdownCache.size > 200) markdownCache.clear();
  markdownCache.set(text, html);
  return html;
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
