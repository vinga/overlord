import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({
  hooks: {
    postprocess(html: string) {
      return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    },
  },
});

const markdownCache = new Map<string, string>();

/**
 * Markdown → sanitized HTML. Repo files are untrusted: raw HTML in a `.md`
 * (`<img onerror>`, `<script>`) would otherwise run in Overlord's origin and
 * reach every side-effecting API (spawn, inject, file write).
 */
export function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const raw = marked.parse(text, { breaks: true, async: false }) as string;
  const html = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
  if (markdownCache.size > 200) markdownCache.clear();
  markdownCache.set(text, html);
  return html;
}
