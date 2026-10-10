/**
 * Flat repo-relative paths → a directory tree → the visible row list.
 * Kept pure so the room file browser only memoizes and renders.
 */

export interface DirNode {
  name: string;
  /** '' for the root, otherwise 'a/b' (no trailing slash). */
  path: string;
  dirs: Map<string, DirNode>;
  files: string[];
}

export interface TreeRow {
  kind: 'dir' | 'file';
  /** Repo-relative; dirs have no trailing slash. */
  path: string;
  name: string;
  depth: number;
}

export function buildTree(paths: readonly string[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(p);
  }
  return root;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Depth-first rows, dirs before files. Children of a collapsed dir are never
 * visited, so a 20k-file repo costs only what is on screen. `expandAll` is the
 * filter case: every surviving dir holds a match, so all of them open.
 */
export function flattenTree(root: DirNode, expanded: ReadonlySet<string>, expandAll: boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: DirNode, depth: number) => {
    const dirNames = [...node.dirs.keys()].sort(byName);
    for (const name of dirNames) {
      const dir = node.dirs.get(name)!;
      rows.push({ kind: 'dir', path: dir.path, name, depth });
      if (expandAll || expanded.has(dir.path)) walk(dir, depth + 1);
    }
    const files = [...node.files].sort((a, b) => byName(baseName(a), baseName(b)));
    for (const f of files) rows.push({ kind: 'file', path: f, name: baseName(f), depth });
  };
  walk(root, 0);
  return rows;
}

/** Whitespace-separated terms, all must appear in the path (case-insensitive). */
export function filterPaths(paths: readonly string[], query: string): readonly string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return paths;
  return paths.filter(p => {
    const lower = p.toLowerCase();
    return terms.every(t => lower.includes(t));
  });
}
