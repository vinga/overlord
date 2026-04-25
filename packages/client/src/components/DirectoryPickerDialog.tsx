import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SessionProvider, TerminalSpawnMode } from '../types';
import styles from './DirectoryPickerDialog.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSpawn: (cwd: string, name: string, mode: TerminalSpawnMode, provider: SessionProvider) => void;
  defaultPath?: string;
  suggestedName?: string;
  bridgePath?: string;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
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

export function DirectoryPickerDialog({ open, onClose, onSpawn, defaultPath, suggestedName, bridgePath }: Props) {
  const [currentPath, setCurrentPath] = useState(defaultPath || '');
  const [pathInput, setPathInput] = useState(defaultPath || '');
  const [dirs, setDirs] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState(suggestedName || '');
  const [mode, setMode] = useState<TerminalSpawnMode>('embedded');
  const [provider, setProvider] = useState<SessionProvider>('claude');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const markerRef = useRef(Math.random().toString(36).slice(2, 10));

  // Sync suggested name when dialog opens
  useEffect(() => {
    if (open && suggestedName) setSessionName(suggestedName);
  }, [open, suggestedName]);

  // Fetch directories when currentPath changes
  useEffect(() => {
    if (!open) return;
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
  }, [currentPath, open]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    if (!suggestedName) {
      const basename = path.split(/[\\/]/).filter(Boolean).pop() || 'New';
      setSessionName(basename);
    }
  }, [suggestedName]);

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') navigateTo(pathInput);
  };

  const handleSpawn = () => {
    if (currentPath && sessionName) onSpawn(currentPath, sessionName, effectiveMode, provider);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setTimeout(() => pathInputRef.current?.focus(), 100);
  }, [open]);

  const availableModes: TerminalSpawnMode[] = provider === 'opencode' ? ['embedded'] : ['embedded', 'bridge', 'plain'];

  useEffect(() => {
    if (!availableModes.includes(mode)) setMode('embedded');
  }, [availableModes, mode]);

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

  const safeName = sessionName.trim().replace(/"/g, '-');
  const bridgeBin = bridgePath ? `"${bridgePath}"` : 'overlord-bridge';
  const marker = markerRef.current;
  const effectiveMode = availableModes.includes(mode) ? mode : 'embedded';

  const modeRows = [
    { key: 'embedded', label: 'Overlord', cmd: null },
    { key: 'bridge',   label: 'Bridge',   cmd: currentPath && sessionName && provider === 'claude' ? `cd "${currentPath}" && ${bridgeBin} --pipe overlord-${marker} -- claude --name "${safeName}___BRG:${marker}"` : null },
    { key: 'plain',    label: 'Direct',   cmd: currentPath && sessionName && provider === 'claude' ? `cd "${currentPath}" && claude --name "${sessionName.trim()}"` : null },
  ] as { key: TerminalSpawnMode; label: string; cmd: string | null }[];
  const visibleModeRows = modeRows.filter(row => availableModes.includes(row.key));

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>New Session</h2>
          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Path input */}
        <div className={styles.pathRow}>
          <input
            ref={pathInputRef}
            className={styles.pathInput}
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={handlePathKeyDown}
            placeholder="Enter directory path..."
            spellCheck={false}
          />
          <button className={styles.goBtn} onClick={() => navigateTo(pathInput)}>Go</button>
        </div>

        {/* Breadcrumbs */}
        <div className={styles.breadcrumbs}>
          {breadcrumbs.map((bc, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
              <button className={styles.breadcrumbBtn} onClick={() => navigateTo(bc.path)}>{bc.label}</button>
            </React.Fragment>
          ))}
        </div>

        {/* Directory list */}
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

        {/* Name row */}
        <div className={styles.config} style={{ paddingBottom: 0 }}>
          <div className={styles.configRow}>
            <label className={styles.label}>Name</label>
            <input
              ref={nameInputRef}
              className={styles.nameInput}
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSpawn(); }}
              placeholder="Session name..."
              spellCheck={false}
            />
          </div>
        </div>

        <div className={styles.config} style={{ paddingBottom: 0, paddingTop: 10 }}>
          <div className={styles.configRow}>
            <label className={styles.label}>Provider</label>
            <div style={{ display: 'flex', gap: 8, flex: 1 }}>
              {([
                { key: 'claude', label: 'Claude' },
                { key: 'opencode', label: 'OpenCode' },
              ] as const).map(option => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setProvider(option.key)}
                  style={{
                    border: provider === option.key ? '1px solid rgba(212,175,55,0.45)' : '1px solid rgba(255,255,255,0.1)',
                    background: provider === option.key ? 'rgba(212,175,55,0.08)' : 'rgba(255,255,255,0.03)',
                    color: provider === option.key ? '#d4af37' : 'rgba(255,255,255,0.65)',
                    borderRadius: 6,
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >{option.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Mode rows — type label left, command right */}
        <div className={styles.modeRows}>
          {visibleModeRows.map(({ key, label, cmd }) => {
            const active = effectiveMode === key;
            return (
              <div
                key={key}
                className={`${styles.modeRow} ${active ? styles.modeRowActive : ''}`}
                onClick={() => setMode(key)}
              >
                <span className={`${styles.modeRowLabel} ${active ? styles.modeRowLabelActive : ''}`}>{label}</span>
                {cmd ? (
                  <>
                    <code className={`${styles.modeRowCmd} ${active ? styles.modeRowCmdActive : ''}`}>{cmd}</code>
                    <CopyBtn text={cmd} />
                  </>
                ) : (
                  <span className={styles.modeRowHint}>Spawns a PTY session managed inside Overlord</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.spawnBtn}
            onClick={handleSpawn}
            disabled={!currentPath || !sessionName}
          >Spawn</button>
        </div>
      </div>
    </div>
  );
}
