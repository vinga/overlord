import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { TerminalSpawnMode } from '../types';
import styles from './DirectoryPickerDialog.module.css';
import { SessionCommands } from './SessionCommands';

interface Props {
  open: boolean;
  onClose: () => void;
  onSpawn: (cwd: string, name: string, mode: TerminalSpawnMode) => void;
  defaultPath?: string;
  suggestedName?: string;
  bridgePath?: string;
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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

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
          // Only fall back to folder basename if no suggested name was provided
          if (!suggestedName) {
            const basename = data.current.split(/[\\/]/).filter(Boolean).pop() || 'New';
            setSessionName(prev => prev || basename);
          }
        }
      })
      .catch(() => setError('Failed to fetch directories'))
      .finally(() => setLoading(false));
  }, [currentPath, open]);

  // Update session name when navigating (only if user hasn't set a custom name and no suggestedName)
  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    if (!suggestedName) {
      const basename = path.split(/[\\/]/).filter(Boolean).pop() || 'New';
      setSessionName(basename);
    }
  }, [suggestedName]);

  // Handle path input Enter
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigateTo(pathInput);
    }
  };

  // Handle spawn
  const handleSpawn = () => {
    if (currentPath && sessionName) {
      onSpawn(currentPath, sessionName, mode);
    }
  };

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Focus path input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => pathInputRef.current?.focus(), 100);
    }
  }, [open]);

  if (!open) return null;

  // Build breadcrumbs from current path
  const segments = currentPath.split(/[\\/]/).filter(Boolean);
  const breadcrumbs: { label: string; path: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const pathParts = segments.slice(0, i + 1);
    // Windows: "C:" needs trailing backslash to be a valid path
    const fullPath = i === 0 && /^[A-Za-z]:$/.test(pathParts[0])
      ? pathParts[0] + '\\'
      : pathParts.join('\\');
    breadcrumbs.push({ label: segments[i], path: fullPath });
  }

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
          <button
            className={styles.goBtn}
            onClick={() => navigateTo(pathInput)}
          >Go</button>
        </div>

        {/* Breadcrumbs */}
        <div className={styles.breadcrumbs}>
          {breadcrumbs.map((bc, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
              <button
                className={styles.breadcrumbBtn}
                onClick={() => navigateTo(bc.path)}
              >{bc.label}</button>
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
                <button
                  className={styles.dirItem}
                  onClick={() => navigateTo(parent)}
                >
                  <span className={styles.dirName}>..</span>
                </button>
              )}
              {dirs.map(dir => (
                <button
                  key={dir}
                  className={styles.dirItem}
                  onClick={() => navigateTo(currentPath + '\\' + dir)}
                >
                  <span className={styles.dirName}>{dir}</span>
                </button>
              ))}
              {dirs.length === 0 && !parent && (
                <div className={styles.emptyDir}>No subdirectories</div>
              )}
            </>
          )}
        </div>

        {/* Session config */}
        <div className={styles.config}>
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
          <div className={styles.configRow}>
            <label className={styles.label}>Type</label>
            <div className={styles.modeSelector}>
              {(['embedded', 'bridge', 'plain'] as TerminalSpawnMode[]).map(m => (
                <button
                  key={m}
                  className={`${styles.modeBtn} ${mode === m ? styles.modeBtnActive : ''}`}
                  onClick={() => setMode(m)}
                >{m === 'embedded' ? 'Overlord' : m === 'bridge' ? 'Bridge' : 'Direct'}</button>
              ))}
            </div>
          </div>
        </div>

        {/* IntelliJ / terminal commands */}
        {currentPath && sessionName && (
          <div className={styles.commandsSection}>
            <SessionCommands
              cwd={currentPath}
              name={sessionName}
              bridgePath={bridgePath}
            />
          </div>
        )}

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
