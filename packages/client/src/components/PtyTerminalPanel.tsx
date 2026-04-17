import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, WorkerState } from '../types';
import { XtermTerminal } from './XtermTerminal';
import { ColorPicker } from './ColorPicker';
import styles from './PtyTerminalPanel.module.css';

// Match DetailPanel's sizing and storage key so width persists across panel types.
const STORAGE_KEY = 'overlord:panelWidth';
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 680;

function getSavedWidth(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_WIDTH;
}

const STATE_COLORS: Record<WorkerState, string> = {
  working: '#22c55e',
  thinking: '#a78bfa',
  waiting: '#f59e0b',
  closed: '#374151',
};

function formatDuration(startedAt: number): string {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

interface PtyTerminalPanelProps {
  sessionId: string;
  session?: Session;
  customName?: string;
  isExited: boolean;
  sendInput: (sessionId: string, data: string) => void;
  resizePty: (sessionId: string, cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => () => void;
  onKill: (sessionId: string) => void;
  onRestart?: (sessionId: string) => void;
  onRename?: (sessionId: string, name: string) => void;
  onClose?: () => void;
  panelWidth?: number;
  onPanelWidthChange?: (width: number) => void;
}

export function PtyTerminalPanel({
  sessionId,
  session,
  customName,
  isExited,
  sendInput,
  resizePty,
  registerOutputHandler,
  onKill,
  onRestart,
  onRename,
  onClose,
  panelWidth,
  onPanelWidthChange,
}: PtyTerminalPanelProps) {
  const [open, setOpen] = useState(false);
  const controlled = panelWidth !== undefined;
  const [internalWidth, setInternalWidth] = useState(getSavedWidth);
  const width = controlled ? panelWidth! : internalWidth;
  const setWidth = (next: number | ((prev: number) => number)) => {
    if (controlled) {
      const resolved = typeof next === 'function' ? next(panelWidth!) : next;
      onPanelWidthChange?.(resolved);
    } else {
      setInternalWidth(next);
    }
  };
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [tick, setTick] = useState(0);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Tick every second to keep duration live
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta));
      setWidth(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth(w => {
        try { localStorage.setItem(STORAGE_KEY, String(w)); } catch {}
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const displayName = customName ?? session?.proposedName ?? session?.slug ?? sessionId.slice(0, 12);

  function startEdit() {
    setEditValue(displayName);
    setIsEditing(true);
  }

  function commitEdit() {
    if (onRename) onRename(sessionId, editValue);
    setIsEditing(false);
  }

  function handleEditKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setIsEditing(false);
  }

  return (
    <div
      className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
      style={{ width }}
    >
      <div className={styles.resizeHandle} onMouseDown={onMouseDown} />

      {/* Header */}
      <div className={styles.header}>
        {session && (
          <ColorPicker
            sessionId={session.sessionId}
            color={session.color}
            size={34}
            isRaw
            onChange={(newColor) => {
              void fetch(`/api/sessions/${session.sessionId}/color`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ color: newColor }),
              });
            }}
          />
        )}
        <div className={styles.headerLeft}>
          {isEditing ? (
            <div className={styles.nameEditRow}>
              <input
                className={styles.nameInput}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleEditKey}
                onBlur={commitEdit}
                autoFocus
                maxLength={60}
              />
              <button className={styles.iconBtn} onClick={commitEdit} title="Save">✓</button>
              <button className={styles.iconBtn} onClick={() => setIsEditing(false)} title="Cancel">✕</button>
            </div>
          ) : (
            <div className={styles.nameRow}>
              <span className={styles.sessionName}>{displayName}</span>
              {onRename && (
                <button className={styles.iconBtn} onClick={startEdit} title="Rename">✎</button>
              )}
            </div>
          )}
        </div>
        <div className={styles.headerRight}>
          <button
            className={`${styles.iconBtn} ${detailsOpen ? styles.iconBtnActive : ''}`}
            onClick={() => setDetailsOpen(s => !s)}
            title={detailsOpen ? 'Hide details' : 'Show details'}
          >
            {detailsOpen ? '▴' : '▾'}
          </button>
          {session?.historyOnly && onRestart && (
            <button
              className={styles.restartBtn}
              onClick={() => onRestart(sessionId)}
              title="Restart shell in original folder"
            >
              ↻ Restart shell
            </button>
          )}
          <button
            className={styles.iconBtn}
            onClick={() => onKill(sessionId)}
            title="Kill session"
          >
            ⏻
          </button>
          {onClose && (
            <button
              className={styles.closeButton}
              onClick={onClose}
              title="Close panel"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Collapsible details */}
      {detailsOpen && session && (
        <div className={styles.details}>
          <div className={styles.detailsGrid}>
            <span className={styles.detailLabel}>Status</span>
            <span className={styles.detailValue}>
              <span
                className={styles.stateDot}
                style={{ background: STATE_COLORS[session.state] }}
              />
              <span style={{ color: STATE_COLORS[session.state] }}>{session.state}</span>
            </span>

            <span className={styles.detailLabel}>PID</span>
            <span className={styles.detailValue}>{session.pid}</span>

            <span className={styles.detailLabel}>Duration</span>
            <span className={styles.detailValue}>{formatDuration(session.startedAt)}</span>

            {session.model && (
              <>
                <span className={styles.detailLabel}>Model</span>
                <span className={styles.detailValue}>{formatModel(session.model)}</span>
              </>
            )}

            {session.ideName && (
              <>
                <span className={styles.detailLabel}>IDE</span>
                <span className={styles.detailValue}>{session.ideName}</span>
              </>
            )}

            <span className={styles.detailLabel}>Workspace</span>
            <span className={`${styles.detailValue} ${styles.cwd}`}>{session.cwd}</span>
          </div>
          {isExited && <div className={styles.exitedBanner}>Session exited</div>}
        </div>
      )}

      {/* Terminal */}
      <div className={styles.terminalArea}>
        <XtermTerminal
          sessionId={sessionId}
          onInput={(data) => sendInput(sessionId, data)}
          onResize={(cols, rows) => resizePty(sessionId, cols, rows)}
          registerOutputHandler={registerOutputHandler}
          isExited={isExited}
          fillHeight
        />
      </div>
    </div>
  );
}
