import hljs from 'highlight.js/lib/common';

/**
 * Syntax-highlights a file and returns one self-contained HTML string per line.
 *
 * `hljs.highlight()` emits a single blob whose `<span>`s freely cross newlines —
 * a block comment opens a span on line 4 and closes it on line 9. Splitting that
 * on `\n` would leak the open tag into every later line and leave unbalanced
 * markup in each fragment. So the blob is walked once, the stack of currently
 * open spans is tracked, and at every newline the open spans are closed and
 * immediately reopened on the next line. Each returned line is valid on its own,
 * which is what lets the viewer keep one `<div>` per line for line numbers.
 */

/** Extensions worth pinning explicitly rather than trusting hljs's alias table. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  diff: 'diff',
  patch: 'diff',
};

/** Files whose *name* identifies the language better than any extension. */
const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.dockerignore': 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
};

/** Above this the per-line spans cost more than they're worth; caller falls back to plain text. */
export const MAX_HIGHLIGHT_LINES = 5000;

/**
 * Resolve a language from a path. Extension-driven only — `highlightAuto` is
 * deliberately not used: on a short or unusual file it picks confidently and
 * wrongly, and a file coloured as the wrong language reads worse than plain text.
 */
export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = FILENAME_LANG[base];
  if (byName) return byName;

  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);

  const mapped = EXT_LANG[ext];
  if (mapped) return hljs.getLanguage(mapped) ? mapped : null;
  // Anything not pinned above: accept it only if hljs actually knows it.
  return hljs.getLanguage(ext) ? ext : null;
}

const TAG_RE = /<span class="[^"]*">|<\/span>/g;

/**
 * Split highlighted HTML into per-line fragments, rebalancing spans at each break.
 * Returns null when there is nothing to highlight, so callers render plain text.
 */
export function highlightToLines(code: string, language: string | null): string[] | null {
  if (!language) return null;
  if (code.split('\n').length > MAX_HIGHLIGHT_LINES) return null;

  let html: string;
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    // Unknown/broken grammar — plain text beats a crash.
    return null;
  }

  const lines: string[] = [];
  const openTags: string[] = [];
  let current = '';
  let cursor = 0;

  const pushText = (text: string): void => {
    // Text between tags may itself span several lines.
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        // Close every open span before the break, reopen it after.
        current += '</span>'.repeat(openTags.length);
        lines.push(current);
        current = openTags.join('');
      }
      current += part;
    });
  };

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    pushText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[0] === '</span>') {
      openTags.pop();
      current += '</span>';
    } else {
      openTags.push(match[0]);
      current += match[0];
    }
  }
  pushText(html.slice(cursor));
  lines.push(current);

  return lines;
}
