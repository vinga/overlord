import { describe, it, expect } from 'vitest';
import { highlightToLines, languageForPath, MAX_HIGHLIGHT_LINES } from '../highlightLines.js';

function balanced(line: string): boolean {
  const open = (line.match(/<span class="[^"]*">/g) ?? []).length;
  const close = (line.match(/<\/span>/g) ?? []).length;
  return open === close;
}

describe('languageForPath', () => {
  it('maps the extensions these repos actually produce', () => {
    expect(languageForPath('/a/b/x.ts')).toBe('typescript');
    expect(languageForPath('/a/b/x.tsx')).toBe('typescript');
    expect(languageForPath('/a/b/x.py')).toBe('python');
    expect(languageForPath('/a/b/x.kt')).toBe('kotlin');
    expect(languageForPath('/a/b/x.yml')).toBe('yaml');
    expect(languageForPath('/a/b/x.html')).toBe('xml');
  });

  it('recognises extensionless files by name', () => {
    expect(languageForPath('/a/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('/a/Makefile')).toBe('makefile');
  });

  it('returns null rather than guessing', () => {
    // No auto-detection: a wrong guess mis-colours the whole file.
    expect(languageForPath('/a/b/x.unknownext')).toBeNull();
    expect(languageForPath('/a/b/noextension')).toBeNull();
  });
});

describe('highlightToLines', () => {
  it('re-opens a multi-line comment on each line and closes it at the end', () => {
    const code = ['const a = 1;', '/* comment', ' still comment', ' end */', 'const b = 2;'].join('\n');
    const lines = highlightToLines(code, 'typescript')!;
    expect(lines).toHaveLength(5);
    // The comment class appears on all three comment lines…
    expect(lines[1]).toContain('hljs-comment');
    expect(lines[2]).toContain('hljs-comment');
    expect(lines[3]).toContain('hljs-comment');
    // …and does not leak past the comment.
    expect(lines[4]).not.toContain('hljs-comment');
  });

  it('emits tag-balanced fragments for every line', () => {
    const code = [
      'function f() {',
      '  /* multi',
      '     line */',
      '  const s = `template',
      '  spanning lines`;',
      '  return s;',
      '}',
    ].join('\n');
    const lines = highlightToLines(code, 'typescript')!;
    lines.forEach((l, i) => expect(balanced(l), `line ${i}: ${l}`).toBe(true));
  });

  it('preserves the line count, trailing blanks included', () => {
    const code = 'a\n\nb\n\n';
    const lines = highlightToLines(code, 'typescript')!;
    expect(lines).toHaveLength(code.split('\n').length);
  });

  it('escapes source HTML instead of injecting it', () => {
    const code = 'const el = "<img src=x onerror=alert(1)>";';
    const lines = highlightToLines(code, 'typescript')!;
    const joined = lines.join('\n');
    expect(joined).not.toContain('<img');
    expect(joined).toContain('&lt;img');
  });

  it('returns null with no language, so the caller renders plain text', () => {
    expect(highlightToLines('anything', null)).toBeNull();
  });

  it('returns null past the line cap', () => {
    const huge = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => `const x${i} = ${i};`).join('\n');
    expect(highlightToLines(huge, 'typescript')).toBeNull();
  });

  it('strips nothing from the visible text', () => {
    const code = 'const answer = 42;';
    const text = highlightToLines(code, 'typescript')!.join('\n').replace(/<[^>]+>/g, '');
    expect(text).toBe(code);
  });
});
