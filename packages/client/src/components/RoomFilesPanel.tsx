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
  /** Tree above the file instead of beside it — for a narrow panel. */
  stacked?: boolean;
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

/** Ask the room at `cwd` to show `rel` (repo-style path) in its Files tree.
 *  Storage is written first so a panel that mounts in response — the room
 *  opening its Files section — starts on the file; a mounted one hears the event. */
export const REVEAL_ROOM_FILE_EVENT = 'overlord:revealRoomFile';
let pendingReveal: { cwd: string; rel: string } | null = null;
export function revealRoomFile(cwd: string, rel: string): void {
  writeStored(`${LAST_FILE_KEY}:${cwd}`, rel);
  writeStored(`${SCOPE_KEY}:${cwd}`, 'all');
  pendingReveal = { cwd, rel };
  window.dispatchEvent(new CustomEvent(REVEAL_ROOM_FILE_EVENT, { detail: { cwd, rel } }));
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const IS_WIN = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
const FOLDER_APP = IS_MAC ? 'Finder' : IS_WIN ? 'Explorer' : 'file manager';

/** Open a folder (or select a file in its folder) in the OS file manager. */
function revealInOs(abs: string, open: boolean): void {
  void fetch('/api/reveal-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: abs, open }),
  });
}

function parentDir(path: string | null): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

const NEW_FILE_NAME = 'untitled.txt';

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
export const RoomFilesPanel = memo(function RoomFilesPanel({ cwd, hasPr = false, stacked = false }: Props) {
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
  const treeRef = useRef<HTMLDivElement>(null);
  // Bumped by a reveal so the scroll effect re-runs even for the same path.
  // A reveal that caused this mount is consumed here; a plain mount never scrolls.
  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(() => {
    if (pendingReveal?.cwd !== cwd) return null;
    const path = pendingReveal.rel;
    pendingReveal = null;
    return { path, n: 0 };
  });

  const source = useMemo(() => roomSource(cwd), [cwd]);
  const root = cwd.replace(/\/+$/, '');

  // New-file input: the path being typed, or null when closed.
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

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

  const startCreate = useCallback((dir: string) => {
    setCreateError('');
    setCreating(dir + NEW_FILE_NAME);
  }, []);

  // Select just the name stem, so typing replaces "untitled" and keeps the folder + extension.
  useEffect(() => {
    const el = createInputRef.current;
    if (creating === null || !el || document.activeElement === el) return;
    el.focus();
    const start = creating.lastIndexOf('/') + 1;
    const dot = creating.lastIndexOf('.');
    el.setSelectionRange(start, dot > start ? dot : creating.length);
  }, [creating]);

  const submitCreate = useCallback(async () => {
    const rel = (creating ?? '').trim().replace(/^\/+/, '');
    if (!rel || createBusy) return;
    if (dirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
    setCreateBusy(true);
    setCreateError('');
    try {
      const r = await fetch('/api/room-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, path: rel }),
      });
      const body = await r.json().catch(() => ({})) as { path?: string; hidden?: string; error?: string };
      if (!r.ok || !body.path) { setCreateError(body.error ?? `Error ${r.status}`); return; }
      if (body.hidden) { setCreateError(`Created, but not shown here: ${body.hidden}`); await load(); return; }
      const made = body.path;
      setCreating(null);
      dirtyRef.current = false;
      setQuery('');
      setScope('all');
      await load();
      setSelected(made);
      setExpanded(prev => new Set([...prev, ...ancestors(made)]));
      setReveal(rv => ({ path: made, n: (rv?.n ?? 0) + 1 }));
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [creating, createBusy, cwd, load, setScope, setSelected]);

  useEffect(() => {
    const onReveal = (ev: Event) => {
      const detail = (ev as CustomEvent<{ cwd: string; rel: string }>).detail;
      if (detail?.cwd !== cwd) return;
      pendingReveal = null;
      if (detail.rel !== selected && dirtyRef.current && !window.confirm('Discard unsaved changes?')) return;
      dirtyRef.current = false;
      setQuery('');
      setScope('all');
      setSelected(detail.rel);
      setExpanded(prev => new Set([...prev, ...ancestors(detail.rel)]));
      setReveal(r => ({ path: detail.rel, n: (r?.n ?? 0) + 1 }));
    };
    window.addEventListener(REVEAL_ROOM_FILE_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ROOM_FILE_EVENT, onReveal);
  }, [cwd, selected, setScope, setSelected]);

  // Center the revealed row in the tree once it has rows. Scrolls the tree only —
  // scrollIntoView would also drag the office page.
  useEffect(() => {
    const tree = treeRef.current;
    if (!reveal || !data || !tree) return;
    const row = tree.querySelector(`[data-path="${CSS.escape(reveal.path)}"]`);
    if (!row) return;
    const offset = row.getBoundingClientRect().top - tree.getBoundingClientRect().top;
    tree.scrollTop += offset - tree.clientHeight / 2;
  }, [reveal, data]);

  return (
    <div className={`${styles.panel} ${stacked ? styles.stacked : ''}`}>
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
            onClick={() => (creating === null ? startCreate(parentDir(selected)) : setCreating(null))}
            data-tooltip="New file"
            data-tooltip-dir="down"
            aria-label="New file"
            aria-pressed={creating !== null}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6z" />
              <polyline points="9 1.5 9 6 13.5 6" />
              <line x1="8" y1="8.5" x2="8" y2="12" />
              <line x1="6.25" y1="10.25" x2="9.75" y2="10.25" />
            </svg>
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => revealInOs(root, true)}
            data-tooltip={`Open folder in ${FOLDER_APP}`}
            data-tooltip-dir="down"
            aria-label={`Open in ${FOLDER_APP}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75H13a1.5 1.5 0 0 1 1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" />
            </svg>
          </button>
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

        {creating !== null && (
          <div className={styles.createRow}>
            <input
              ref={createInputRef}
              className={styles.search}
              value={creating}
              onChange={e => { setCreating(e.target.value); setCreateError(''); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void submitCreate(); }
                else if (e.key === 'Escape') { e.preventDefault(); setCreating(null); }
              }}
              placeholder="folder/new-file.txt"
              spellCheck={false}
              disabled={createBusy}
              aria-label="New file path"
            />
            <div className={styles.createHint}>
              {createError
                ? <span className={styles.createError}>{createError}</span>
                : <>Enter to create · Esc to cancel</>}
            </div>
          </div>
        )}

        <div className={styles.tree} role="tree" ref={treeRef}>
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
                <div key={`d:${row.path}`} className={styles.dirWrap}>
                  <button
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
                  <span className={styles.dirActions}>
                    <button
                      className={styles.dirAction}
                      onClick={() => startCreate(`${row.path}/`)}
                      title={`New file in ${row.path}/`}
                      aria-label={`New file in ${row.path}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                        <line x1="8" y1="3" x2="8" y2="13" />
                        <line x1="3" y1="8" x2="13" y2="8" />
                      </svg>
                    </button>
                    <button
                      className={styles.dirAction}
                      onClick={() => revealInOs(`${root}/${row.path}`, true)}
                      title={`Open in ${FOLDER_APP}`}
                      aria-label={`Open ${row.path} in ${FOLDER_APP}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75H13a1.5 1.5 0 0 1 1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" />
                      </svg>
                    </button>
                  </span>
                </div>
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
                data-path={row.path}
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
