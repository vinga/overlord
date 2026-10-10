import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileEditorView, FILE_EDITOR_MODE_KEY, type DiffSource, type FileSource } from './FileEditorOverlay';
import { buildTree, filterPaths, flattenTree } from '../lib/fileTree';
import styles from './RoomFilesPanel.module.css';

type ChangeCode = 'M' | 'A' | 'D' | '?' | 'R';

interface RoomFilesResponse {
  files: string[];
  /** Uncommitted, vs HEAD. */
  changed: Record<string, ChangeCode>;
  /** Branch work vs the merge-base with `base`; absent on the base branch. */
  prChanged?: Record<string, ChangeCode>;
  base?: string;
  truncated: boolean;
  git: boolean;
}

interface Props {
  cwd: string;
  /** Labels the branch scope "In PR" instead of "In branch". */
  hasPr?: boolean;
}

type Scope = 'all' | 'uncommitted' | 'pr';

const SCOPE_KEY = 'overlord:roomFilesScope';
const LAST_FILE_KEY = 'overlord:roomFilesLast';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Rows past this are not rendered — a one-letter filter on a big repo would otherwise mount 20k buttons. */
const MAX_ROWS = 1500;

const CHANGE_LABEL: Record<ChangeCode, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', '?': 'Untracked', R: 'Renamed',
};

function roomSource(cwd: string): FileSource {
  const root = cwd.replace(/\/+$/, '');
  return {
    load: (path) => fetch(`/api/room-file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
    save: (path, content) => fetch('/api/room-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, path, content }),
    }),
    imageUrl: (path) => `/api/room-file-raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    absolutePath: (path) => `${root}/${path}`,
  };
}

/**
 * Per-room file browser: gitignore-aware tree on the left, the inline file
 * editor on the right. Only mounted while the room's Files section is open,
 * and only fetches on mount / refresh — git spawns are too costly for a timer.
 */
export const RoomFilesPanel = memo(function RoomFilesPanel({ cwd, hasPr = false }: Props) {
  const [data, setData] = useState<RoomFilesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScopeState] = useState<Scope>(() => {
    const saved = readStored(`${SCOPE_KEY}:${cwd}`);
    return saved === 'uncommitted' || saved === 'pr' ? saved : 'all';
  });
  const [selected, setSelectedState] = useState<string | null>(() => readStored(`${LAST_FILE_KEY}:${cwd}`));
  // The restored file's folders start open, so it is visible in the tree.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(selected ? ancestors(selected) : []));

  const setScope = useCallback((s: Scope) => {
    setScopeState(s);
    writeStored(`${SCOPE_KEY}:${cwd}`, s);
  }, [cwd]);
  const setSelected = useCallback((p: string | null) => {
    setSelectedState(p);
    writeStored(`${LAST_FILE_KEY}:${cwd}`, p);
  }, [cwd]);
  const dirtyRef = useRef(false);
  const reqRef = useRef(0);

  const source = useMemo(() => roomSource(cwd), [cwd]);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/api/room-files?cwd=${encodeURIComponent(cwd)}`);
      if (req !== reqRef.current) return;
      if (!r.ok) {
        const reason = await r.json().then((b: { error?: string }) => b.error).catch(() => undefined);
        if (req !== reqRef.current) return;
        setError(reason ?? `Error ${r.status}`);
        setData(null);
      } else {
        const body = await r.json() as RoomFilesResponse;
        if (req !== reqRef.current) return;
        setData(body);
      }
    } catch (err) {
      if (req === reqRef.current) setError(String(err));
    }
    if (req === reqRef.current) setLoading(false);
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  // A remembered file that has since vanished (and is not a deletion we can
  // still diff) is dropped rather than shown as an error.
  useEffect(() => {
    if (!data || !selected) return;
    if (data.files.includes(selected) || data.changed[selected] || data.prChanged?.[selected]) return;
    setSelected(null);
  }, [data, selected, setSelected]);

  // 'pr' remembered for a room now sitting on its base branch reads as 'all'.
  const activeScope: Scope = scope === 'pr' && !data?.prChanged ? 'all' : scope;
  const changes: Record<string, ChangeCode> = useMemo(() => {
    if (!data) return {};
    return activeScope === 'pr' ? data.prChanged ?? {} : data.changed;
  }, [data, activeScope]);

  const visiblePaths = useMemo(() => {
    if (!data) return [];
    const base = activeScope === 'all' ? data.files : Object.keys(changes);
    return filterPaths(base, query);
  }, [data, activeScope, changes, query]);

  const tree = useMemo(() => buildTree(visiblePaths), [visiblePaths]);
  const expandAll = query.trim() !== '' || activeScope !== 'all';
  const rows = useMemo(() => flattenTree(tree, expanded, expandAll), [tree, expanded, expandAll]);
  const shownRows = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;

  const changedCount = data ? Object.keys(data.changed).length : 0;
  const prCount = data?.prChanged ? Object.keys(data.prChanged).length : 0;

  // Diff vs HEAD for uncommitted work, vs the merge-base for branch work. In
  // 'all', an uncommitted change wins — it is the more recent question.
  const diffScope: 'head' | 'pr' | null = !selected || !data
    ? null
    : activeScope === 'pr'
      ? (data.prChanged?.[selected] ? 'pr' : null)
      : data.changed[selected]
        ? 'head'
        : data.prChanged?.[selected] ? 'pr' : null;
  const diffSource: DiffSource | null = useMemo(() => (selected && diffScope ? {
    load: () => fetch(`/api/room-file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selected)}&scope=${diffScope}`),
  } : null), [cwd, selected, diffScope]);
  const selectedMissing = !!selected && (changes[selected] ?? data?.changed[selected]) === 'D';

  const toggleDir = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const selectFile = useCallback((path: string) => {
    if (path === selected) return;
    if (dirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
    dirtyRef.current = false;
    setSelected(path);
  }, [selected, setSelected]);

  const onDirtyChange = useCallback((d: boolean) => { dirtyRef.current = d; }, []);

  return (
    <div className={styles.panel}>
      <div className={styles.sidebar}>
        <div className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <svg className={styles.searchIcon} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
            <input
              className={styles.search}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter files…"
              spellCheck={false}
              aria-label="Filter files"
            />
            {query && (
              <button className={styles.clearBtn} onClick={() => setQuery('')} aria-label="Clear filter">✕</button>
            )}
          </div>
          <button
            className={styles.iconBtn}
            onClick={() => void load()}
            disabled={loading}
            data-tooltip="Refresh"
            data-tooltip-dir="down"
            aria-label="Refresh file list"
          >
            <svg className={loading ? styles.spin : undefined} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
              <polyline points="13.5 2.5 13.5 5.5 10.5 5.5" />
            </svg>
          </button>
        </div>
        {data?.git && (
          <div className={styles.filterRow}>
            <button
              className={`${styles.chip} ${activeScope === 'all' ? styles.chipActive : ''}`}
              onClick={() => setScope('all')}
              aria-pressed={activeScope === 'all'}
            >
              All
            </button>
            <button
              className={`${styles.chip} ${activeScope === 'uncommitted' ? styles.chipActive : ''}`}
              onClick={() => setScope('uncommitted')}
              aria-pressed={activeScope === 'uncommitted'}
              data-tooltip="Uncommitted changes, vs HEAD"
              data-tooltip-dir="down"
            >
              Uncommitted
              <span className={styles.chipCount}>{changedCount}</span>
            </button>
            {data.prChanged && (
              <button
                className={`${styles.chip} ${activeScope === 'pr' ? styles.chipActive : ''}`}
                onClick={() => setScope('pr')}
                aria-pressed={activeScope === 'pr'}
                data-tooltip={`Changed on this branch vs ${data.base ?? 'base'}, uncommitted included`}
                data-tooltip-dir="down"
              >
                {hasPr ? 'In PR' : 'In branch'}
                <span className={styles.chipCount}>{prCount}</span>
              </button>
            )}
            <span className={styles.fileCount}>{visiblePaths.length} files</span>
          </div>
        )}

        <div className={styles.tree} role="tree">
          {error && <div className={styles.empty}>{error}</div>}
          {!error && loading && !data && <div className={styles.empty}>Loading…</div>}
          {!error && data && rows.length === 0 && (
            <div className={styles.empty}>{activeScope === 'all' || query ? 'No matching files' : 'No changed files'}</div>
          )}
          {shownRows.map(row => {
            const pad = { paddingLeft: 8 + row.depth * 12 };
            if (row.kind === 'dir') {
              const open = expandAll || expanded.has(row.path);
              return (
                <button
                  key={`d:${row.path}`}
                  className={styles.row}
                  style={pad}
                  onClick={() => toggleDir(row.path)}
                  disabled={expandAll}
                  role="treeitem"
                  aria-expanded={open}
                >
                  <svg className={styles.chevron} width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                    <polyline points="2 3 5 6 8 3" />
                  </svg>
                  <span className={styles.dirName}>{row.name}</span>
                </button>
              );
            }
            const change = changes[row.path];
            const deleted = change === 'D';
            return (
              <button
                key={`f:${row.path}`}
                className={`${styles.row} ${row.path === selected ? styles.rowSelected : ''} ${deleted ? styles.rowDeleted : ''}`}
                style={pad}
                onClick={() => selectFile(row.path)}
                title={deleted ? `${row.path} — deleted, diff only` : row.path}
                role="treeitem"
                aria-selected={row.path === selected}
              >
                <span className={styles.fileSpacer} />
                <span className={`${styles.fileName} ${change ? styles[`change_${change === '?' ? 'U' : change}`] : ''}`}>{row.name}</span>
                {change && (
                  <span className={`${styles.badge} ${styles[`change_${change === '?' ? 'U' : change}`]}`} title={CHANGE_LABEL[change]}>
                    {change === '?' ? 'U' : change}
                  </span>
                )}
              </button>
            );
          })}
          {rows.length > MAX_ROWS && (
            <div className={styles.notice}>{rows.length - MAX_ROWS} more — refine the filter</div>
          )}
        </div>
        {data?.truncated && (
          <div className={styles.notice}>Large repo — list truncated. Use the filter.</div>
        )}
      </div>

      <div className={styles.viewer}>
        {selected
          ? (
            <FileEditorView
              key={selected}
              className={styles.editor}
              path={selected}
              source={source}
              onDirtyChange={onDirtyChange}
              modeStorageKey={`${FILE_EDITOR_MODE_KEY}:${cwd}`}
              diff={diffSource}
              missing={selectedMissing}
            />
          )
          : <div className={styles.placeholder}>Select a file to view or edit</div>}
      </div>
    </div>
  );
});
