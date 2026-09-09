import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, WorkerState } from '../types';
import { XtermTerminal } from './XtermTerminal';
import { ColorPicker } from './ColorPicker';
import styles from './PtyTerminalPanel.module.css';

// Match DetailPanel's sizing and storage keys so panel size persists across panel types.
const WIDTH_KEY = 'overlord:panelWidth';
const HEIGHT_KEY = 'overlord:panelHeight';
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 680;
const MIN_HEIGHT = 240;

function getSavedSize(dock: 'right' | 'bottom'): number {
  const key = dock === 'bottom' ? HEIGHT_KEY : WIDTH_KEY;
  const min = dock === 'bottom' ? MIN_HEIGHT : MIN_WIDTH;
  const max = dock === 'bottom' ? Math.max(MIN_HEIGHT, window.innerHeight - 160) : MAX_WIDTH;
  try {
    const v = localStorage.getItem(key);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= min && n <= max) return n;
    }
  } catch {}
  return dock === 'bottom' ? Math.round(window.innerHeight * 0.5) : DEFAULT_WIDTH;
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
  /** Which screen edge the panel docks to. Bottom = portrait / horizontal split. */
  dock?: 'right' | 'bottom';
  /** Width when right-docked, height when bottom-docked. */
  panelSize?: number;
  onPanelSizeChange?: (size: number) => void;
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
  dock = 'right',
  panelSize,
  onPanelSizeChange,
}: PtyTerminalPanelProps) {
  const [open, setOpen] = useState(false);
  const horizontal = dock !== 'bottom';
  const controlled = panelSize !== undefined;
  const [internalSize, setInternalSize] = useState(() => getSavedSize(dock));
  const size = controlled ? panelSize! : internalSize;
  const setSize = (next: number | ((prev: number) => number)) => {
    if (controlled) {
      const resolved = typeof next === 'function' ? next(panelSize!) : next;
      onPanelSizeChange?.(resolved);
    } else {
      setInternalSize(next);
    }
  };
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [tick, setTick] = useState(0);

  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

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
    startPos.current = horizontal ? e.clientX : e.clientY;
    startSize.current = size;
    document.body.style.cursor = horizontal ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [size, horizontal]);

  useEffect(() => {
    const min = horizontal ? MIN_WIDTH : MIN_HEIGHT;
    const max = horizontal ? MAX_WIDTH : Math.max(MIN_HEIGHT, window.innerHeight - 160);
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startPos.current - (horizontal ? e.clientX : e.clientY);
      const next = Math.max(min, Math.min(max, startSize.current + delta));
      setSize(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSize(s => {
        try { localStorage.setItem(horizontal ? WIDTH_KEY : HEIGHT_KEY, String(s)); } catch {}
        return s;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [horizontal]);

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
      className={`${styles.panel} ${dock === 'bottom' ? styles.panelBottom : ''} ${open ? styles.panelOpen : ''}`}
      style={dock === 'bottom' ? { height: size } : { width: size }}
    >
      <div
        className={`${styles.resizeHandle} ${dock === 'bottom' ? styles.resizeHandleTop : ''}`}
        onMouseDown={onMouseDown}
      />

      {/* Header */}
      <div className={styles.header}>
        {session && (
          <ColorPicker
            sessionId={session.sessionId}
            color={session.color}
            size={34}
            isRaw
            icon={session.icon}
            onChange={(newColor) => {
              void fetch(`/api/sessions/${session.sessionId}/color`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ color: newColor }),
              });
            }}
            onIconChange={(newIcon) => {
              void fetch(`/api/sessions/${session.sessionId}/icon`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icon: newIcon }),
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
