import { describe, it, expect } from 'vitest';
import { buildTree, flattenTree, filterPaths } from '../fileTree';

const FILES = ['src/b.ts', 'src/a.ts', 'README.md', 'src/lib/x.ts', 'docs/guide.md'];

describe('fileTree', () => {
  it('lists dirs before files, collapsed by default', () => {
    const rows = flattenTree(buildTree(FILES), new Set(), false);
    expect(rows.map(r => r.path)).toEqual(['docs', 'src', 'README.md']);
  });

  it('expands only the requested dirs', () => {
    const rows = flattenTree(buildTree(FILES), new Set(['src']), false);
    expect(rows.map(r => `${r.depth}:${r.path}`)).toEqual([
      '0:docs', '0:src', '1:src/lib', '1:src/a.ts', '1:src/b.ts', '0:README.md',
    ]);
  });

  it('expandAll opens every dir', () => {
    const rows = flattenTree(buildTree(FILES), new Set(), true);
    expect(rows.filter(r => r.kind === 'file')).toHaveLength(FILES.length);
  });

  it('filters by all terms, case-insensitive', () => {
    expect(filterPaths(FILES, 'SRC ts')).toEqual(['src/b.ts', 'src/a.ts', 'src/lib/x.ts']);
    expect(filterPaths(FILES, 'lib x')).toEqual(['src/lib/x.ts']);
    expect(filterPaths(FILES, '  ')).toBe(FILES);
  });
});
