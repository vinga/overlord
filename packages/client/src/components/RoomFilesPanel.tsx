import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileEditorView, type FileSource } from './FileEditorOverlay';
import { buildTree, filterPaths, flattenTree } from '../lib/fileTree';
import styles from './RoomFilesPanel.module.css';

type ChangeCode = 'M' | 'A' | 'D' | '?' | 'R';

interface RoomFilesResponse {
  files: string[];
  changed: Record<string, ChangeCode>;
  truncated: boolean;
  git: boolean;
}

interface Props {
  cwd: string;
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
export const RoomFilesPanel = memo(function RoomFilesPanel({ cwd }: Props) {
  const [data, setData] = useState<RoomFilesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
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

  const visiblePaths = useMemo(() => {
    if (!data) return [];
    const base = changedOnly ? Object.keys(data.changed) : data.files;
    return filterPaths(base, query);
  }, [data, changedOnly, query]);

  const tree = useMemo(() => buildTree(visiblePaths), [visiblePaths]);
  const expandAll = query.trim() !== '' || changedOnly;
  const rows = useMemo(() => flattenTree(tree, expanded, expandAll), [tree, expanded, expandAll]);
  const shownRows = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;

  const changedCount = data ? Object.keys(data.changed).length : 0;

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
  }, [selected]);

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
              className={`${styles.chip} ${changedOnly ? styles.chipActive : ''}`}
              onClick={() => setChangedOnly(v => !v)}
              aria-pressed={changedOnly}
            >
              Changed only
              <span className={styles.chipCount}>{changedCount}</span>
            </button>
            <span className={styles.fileCount}>{visiblePaths.length} files</span>
          </div>
        )}

        <div className={styles.tree} role="tree">
          {error && <div className={styles.empty}>{error}</div>}
          {!error && loading && !data && <div className={styles.empty}>Loading…</div>}
          {!error && data && rows.length === 0 && (
            <div className={styles.empty}>{changedOnly ? 'No changed files' : 'No matching files'}</div>
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
            const change = data?.changed[row.path];
            const deleted = change === 'D';
            return (
              <button
                key={`f:${row.path}`}
                className={`${styles.row} ${row.path === selected ? styles.rowSelected : ''} ${deleted ? styles.rowDeleted : ''}`}
                style={pad}
                onClick={() => selectFile(row.path)}
                disabled={deleted}
                title={row.path}
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
            />
          )
          : <div className={styles.placeholder}>Select a file to view or edit</div>}
      </div>
    </div>
  );
});
