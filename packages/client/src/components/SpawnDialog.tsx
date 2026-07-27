import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import type { SessionProvider, TerminalSpawnMode } from '../types';
import { ROOM_PREFIX_ENABLED } from '../config/featureFlags';
import styles from './SpawnDialog.module.css';

/** UI-level provider — 'shell' maps to spawn mode 'raw' (no LLM), it never
 *  reaches the SessionProvider union. */
type UiProvider = 'claude' | 'opencode' | 'shell';

interface Props {
  open: boolean;
  onClose: () => void;
  /** `name` arrives with the room prefix already applied; `prefix` is passed
   *  separately so the room caller can persist it to /api/room-config. */
  onSpawn: (cwd: string, name: string, mode: TerminalSpawnMode, provider: SessionProvider, prefix: string) => void;
  /** Set ⇒ room variant: directory row collapsed to this path (expandable). */
  fixedCwd?: string;
  defaultPath?: string;
  suggestedName?: string;
  /** Room variant only — shown as the prefix input, debounce-saved to /api/room-config. */
  initialPrefix?: string;
  onPrefixSaved?: (prefix: string) => void;
  bridgePath?: string;
  onCopyAndClose?: () => void;
}

function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  return (
    <span
      onMouseEnter={e => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top - 8 });
        setVisible(true);
      }}
      onMouseLeave={() => setVisible(false)}
      style={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', color: 'rgba(255,255,255,0.25)', flexShrink: 0 }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4"/>
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="9" fontFamily="Inter,system-ui,sans-serif" fontWeight="600">i</text>
      </svg>
      {visible && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)',
          background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 7, padding: '8px 12px', maxWidth: 260,
          fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, lineHeight: 1.5,
          color: 'rgba(255,255,255,0.75)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 9999, pointerEvents: 'none',
        }}>{text}</div>,
        document.body
      )}
    </span>
  );
}

function CopyBtn({ text, onAfterCopy }: { text: string; onAfterCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        onAfterCopy?.();
      }}
      title="Copy"
      style={{ flexShrink: 0, background: 'none', border: 'none', color: copied ? '#22c55e' : 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: '2px 4px', borderRadius: 3, display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
    >
      {copied
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

const PROVIDER_OPTIONS: { key: UiProvider; label: string; hint: string }[] = [
  { key: 'claude', label: 'Claude', hint: '' },
  { key: 'opencode', label: 'OpenCode', hint: '' },
  { key: 'shell', label: 'Shell', hint: 'Embedded terminal running a plain shell — no Claude, no LLM. Useful for git, file ops, running scripts.' },
];

const MODE_TOOLTIPS: Record<string, string> = {
  embedded: 'Spawns a PTY session managed entirely inside Overlord. No terminal window needed — inject messages, view output, and monitor state directly from the UI.',
  bridge: 'Opens Terminal.app with a named-pipe relay. Overlord can inject messages and track the session while you keep full terminal control.',
  plain: 'Opens Terminal.app running claude directly. No relay — Overlord monitors via session files only. Use when bridge is not needed.',
};

/**
 * Unified New Session dialog. Two variants:
 * - picker (no `fixedCwd`): directory browser expanded, used from the header "+".
 * - room (`fixedCwd` set): directory collapsed to the room path (expandable),
 *   with the room-scoped name prefix input.
 */
export function SpawnDialog({ open, onClose, onSpawn, fixedCwd, defaultPath, suggestedName, initialPrefix, onPrefixSaved, bridgePath, onCopyAndClose }: Props) {
  const isRoom = fixedCwd != null;
  // Room prefix is behind VITE_OVERLORD_ROOM_PREFIX — off by default, so the
  // input is hidden, nothing is saved, and no prefix reaches the spawned name.
  const prefixEnabled = isRoom && ROOM_PREFIX_ENABLED;
  const [currentPath, setCurrentPath] = useState(fixedCwd || defaultPath || '');
  const [pathInput, setPathInput] = useState(fixedCwd || defaultPath || '');
  const [dirExpanded, setDirExpanded] = useState(!isRoom);
  const [dirs, setDirs] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState(suggestedName || '');
  const [prefix, setPrefix] = useState(initialPrefix || '');
  const [mode, setMode] = useState<TerminalSpawnMode>('embedded');
  const [uiProvider, setUiProvider] = useState<UiProvider>('claude');
  const [fetchedBridgePath, setFetchedBridgePath] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const markerRef = useRef(Math.random().toString(36).slice(2, 10));
  const prefixSavedRef = useRef(initialPrefix || '');
  const prefixDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset per-open state (App keeps the dialog mounted with open=false;
  // Room mounts it conditionally, where initializers already handle this).
  useEffect(() => {
    if (!open) return;
    if (suggestedName) setSessionName(suggestedName);
    if (isRoom) {
      setCurrentPath(fixedCwd!);
      setPathInput(fixedCwd!);
      setDirExpanded(false);
      setPrefix(initialPrefix || '');
      prefixSavedRef.current = initialPrefix || '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Room variant: debounce-save the prefix to /api/room-config as it's typed.
  useEffect(() => {
    if (!prefixEnabled || !open) return;
    if (prefix === prefixSavedRef.current) return;
    if (prefixDebounceRef.current) clearTimeout(prefixDebounceRef.current);
    prefixDebounceRef.current = setTimeout(() => {
      prefixDebounceRef.current = null;
      const value = prefix;
      fetch('/api/room-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: fixedCwd, prefix: value }),
      }).then(r => {
        if (r.ok) {
          prefixSavedRef.current = value;
          onPrefixSaved?.(value);
        }
      }).catch(() => {});
    }, 500);
    return () => {
      if (prefixDebounceRef.current) {
        clearTimeout(prefixDebounceRef.current);
        prefixDebounceRef.current = null;
      }
    };
  }, [prefix, prefixEnabled, open, fixedCwd, onPrefixSaved]);

  // Fetch directories only while the browser is expanded.
  useEffect(() => {
    if (!open || !dirExpanded) return;
    setLoading(true);
    setError(null);
    const url = currentPath
      ? `/api/directories?path=${encodeURIComponent(currentPath)}`
      : '/api/directories';
    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
          setDirs([]);
          setParent(null);
        } else {
          setDirs(data.dirs);
          setParent(data.parent);
          setCurrentPath(data.current);
          setPathInput(data.current);
          if (!suggestedName) {
            const basename = data.current.split(/[\\/]/).filter(Boolean).pop() || 'New';
            setSessionName(prev => prev || basename);
          }
        }
      })
      .catch(() => setError('Failed to fetch directories'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, open, dirExpanded]);

  // Bridge path fallback when the caller doesn't supply one (room variant).
  useEffect(() => {
    if (!open || bridgePath) return;
    fetch('/api/info')
      .then(r => r.json())
      .then((info: { bridgePath?: string }) => { if (info.bridgePath) setFetchedBridgePath(info.bridgePath); })
      .catch(() => {});
  }, [open, bridgePath]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    if (!suggestedName) {
      const basename = path.split(/[\\/]/).filter(Boolean).pop() || 'New';
      setSessionName(basename);
    }
  }, [suggestedName]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => {
      if (isRoom) { nameInputRef.current?.focus(); nameInputRef.current?.select(); }
      else pathInputRef.current?.focus();
    }, 100);
  }, [open, isRoom]);

  const availableModes: TerminalSpawnMode[] =
    uiProvider === 'claude' ? ['embedded', 'bridge', 'plain'] : ['embedded'];

  useEffect(() => {
    if (!availableModes.includes(mode)) setMode('embedded');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiProvider]);

  if (!open) return null;

  const segments = currentPath.split(/[\\/]/).filter(Boolean);
  const breadcrumbs: { label: string; path: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const pathParts = segments.slice(0, i + 1);
    const fullPath = i === 0 && /^[A-Za-z]:$/.test(pathParts[0])
      ? pathParts[0] + '\\'
      : '/' + pathParts.join('/');
    breadcrumbs.push({ label: segments[i], path: fullPath });
  }

  const effPrefix = prefixEnabled ? prefix : '';
  const fullName = (effPrefix + sessionName).trim();
  const safeName = fullName.replace(/["\s]/g, '-');
  const effBridgePath = bridgePath ?? fetchedBridgePath;
  const bridgeBin = effBridgePath ? `"${effBridgePath}"` : 'overlord-bridge';
  const marker = markerRef.current;
  const effectiveMode = availableModes.includes(mode) ? mode : 'embedded';

  const handleSpawn = () => {
    if (!currentPath || !sessionName.trim()) return;
    const spawnMode: TerminalSpawnMode = uiProvider === 'shell' ? 'raw' : effectiveMode;
    const provider: SessionProvider = uiProvider === 'opencode' ? 'opencode' : 'claude';
    onSpawn(currentPath, effPrefix + sessionName.trim(), spawnMode, provider, effPrefix);
  };

  const modeRows = [
    { key: 'embedded', label: 'Overlord', cmd: null },
    { key: 'bridge',   label: 'Bridge',   cmd: currentPath && fullName && uiProvider === 'claude' ? `cd "${currentPath}" && ${bridgeBin} --pipe overlord-${marker} -- claude --name "${safeName}___BRG:${marker}"` : null },
    { key: 'plain',    label: 'Direct',   cmd: currentPath && fullName && uiProvider === 'claude' ? `cd "${currentPath}" && claude --name "${fullName}"` : null },
  ] as { key: TerminalSpawnMode; label: string; cmd: string | null }[];
  const visibleModeRows = modeRows.filter(row => availableModes.includes(row.key));
  const shellSelected = uiProvider === 'shell';

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>New Session</h2>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Directory — collapsed row (room) or full browser (picker / expanded) */}
        {!dirExpanded ? (
          <div
            className={styles.dirCollapsed}
            onClick={() => setDirExpanded(true)}
            title="Change directory"
          >
            <span className={styles.dirCollapsedPath}>{currentPath}</span>
            <span className={styles.dirChevron}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3 5 6 8 3" />
              </svg>
            </span>
          </div>
        ) : (
          <>
            <div className={styles.pathRow}>
              <input
                ref={pathInputRef}
                className={styles.pathInput}
                value={pathInput}
                onChange={e => setPathInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') navigateTo(pathInput); }}
                placeholder="Enter directory path..."
                spellCheck={false}
              />
              <button className={styles.goBtn} onClick={() => navigateTo(pathInput)}>Go</button>
            </div>

            <div className={styles.breadcrumbs}>
              {breadcrumbs.map((bc, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
                  <button className={styles.breadcrumbBtn} onClick={() => navigateTo(bc.path)}>{bc.label}</button>
                </React.Fragment>
              ))}
            </div>

            <div className={styles.dirList}>
              {error && <div className={styles.error}>{error}</div>}
              {loading && <div className={styles.loading}>Loading...</div>}
              {!loading && !error && (
                <>
                  {parent && (
                    <button className={styles.dirItem} onClick={() => navigateTo(parent)}>
                      <span className={styles.dirName}>..</span>
                    </button>
                  )}
                  {dirs.map(dir => (
                    <button key={dir} className={styles.dirItem} onClick={() => navigateTo(currentPath + '/' + dir)}>
                      <span className={styles.dirName}>{dir}</span>
                    </button>
                  ))}
                  {dirs.length === 0 && !parent && <div className={styles.emptyDir}>No subdirectories</div>}
                </>
              )}
            </div>
          </>
        )}

        {/* Name row (+ room prefix) */}
        <div className={styles.config} style={{ paddingBottom: 0 }}>
          <div className={styles.configRow}>
            <label className={styles.label}>Name</label>
            <div style={{ display: 'flex', gap: 4, flex: 1 }}>
              {prefixEnabled && (
                <input
                  className={`${styles.nameInput} ${styles.prefixInput}`}
                  value={prefix}
                  onChange={e => setPrefix(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSpawn(); }}
                  placeholder="prefix…"
                  spellCheck={false}
                  title="Session prefix — saved for this room"
                  style={{ fontStyle: prefix ? 'normal' : 'italic' }}
                />
              )}
              <input
                ref={nameInputRef}
                className={styles.nameInput}
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSpawn(); }}
                placeholder="Session name..."
                spellCheck={false}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        </div>

        {/* Provider row — Shell is a provider-level choice (spawns a raw shell) */}
        <div className={styles.config} style={{ paddingBottom: 0, paddingTop: 10 }}>
          <div className={styles.configRow}>
            <label className={styles.label}>Provider</label>
            <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
              {PROVIDER_OPTIONS.map(option => (
                <button
                  key={option.key}
                  type="button"
                  className={`${styles.providerBtn} ${uiProvider === option.key ? styles.providerBtnActive : ''}`}
                  onClick={() => setUiProvider(option.key)}
                >{option.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Mode rows (hidden for Shell — a raw shell is always embedded) */}
        {shellSelected ? (
          <div className={styles.modeRows}>
            <div className={`${styles.modeRow} ${styles.modeRowActive}`}>
              <span className={`${styles.modeRowLabel} ${styles.modeRowLabelActive}`}>Shell</span>
              <span className={styles.modeRowHint}>Embedded terminal running a plain shell — no Claude, no LLM</span>
            </div>
          </div>
        ) : (
          <div className={styles.modeRows}>
            {visibleModeRows.map(({ key, label, cmd }) => {
              const active = effectiveMode === key;
              return (
                <div
                  key={key}
                  className={`${styles.modeRow} ${active ? styles.modeRowActive : ''}`}
                  onClick={() => setMode(key)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <span className={`${styles.modeRowLabel} ${active ? styles.modeRowLabelActive : ''}`} style={{ width: 'auto', minWidth: 56 }}>{label}</span>
                    <InfoTooltip text={MODE_TOOLTIPS[key] ?? ''} />
                  </span>
                  {cmd ? (
                    <>
                      <code className={`${styles.modeRowCmd} ${active ? styles.modeRowCmdActive : ''}`}>{cmd}</code>
                      <CopyBtn text={cmd} onAfterCopy={onCopyAndClose ? () => { onClose(); onCopyAndClose(); } : undefined} />
                    </>
                  ) : (
                    <span className={styles.modeRowHint}>Spawns a PTY session managed inside Overlord</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.spawnBtn}
            onClick={handleSpawn}
            disabled={!currentPath || !sessionName.trim()}
          >Spawn</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
