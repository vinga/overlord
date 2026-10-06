import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../types';
import { ColorPicker } from './ColorPicker';
import { putSessionColor, putSessionIcon } from '../lib/sessionAppearance';
import { useMarkdownEditor, MarkdownToolbar, MarkdownEditorContent } from './MarkdownEditor';
import panelStyles from './PtyTerminalPanel.module.css';
import styles from './NotePanel.module.css';

// Same sizing and storage keys as DetailPanel / PtyTerminalPanel so panel size
// persists across panel types.
const WIDTH_KEY = 'overlord:panelWidth';
const HEIGHT_KEY = 'overlord:panelHeight';
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 240;
const SAVE_DEBOUNCE_MS = 800;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface NotePanelProps {
  sessionId: string;
  session?: Session;
  customName?: string;
  onRename?: (sessionId: string, name: string) => void;
  onDelete: (sessionId: string) => void;
  /** Close the note — the card stays in the room, dimmed. Editing reopens it. */
  onCloseNote?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onClose?: () => void;
  dock?: 'right' | 'bottom';
  panelSize: number;
  onPanelSizeChange: (size: number) => void;
}

function formatEdited(iso: string | undefined): string | null {
  if (!iso) return null;
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'Edited just now';
  if (diffMin < 60) return `Edited ${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `Edited ${h}h ago`;
  return `Edited ${new Date(iso).toLocaleDateString()}`;
}

/**
 * Panel for a notepad session: a WYSIWYG markdown editor, no terminal, no
 * conversation. Content is loaded from and autosaved to /api/notes/:id.
 * Mount with `key={sessionId}` so switching notes flushes the previous one.
 */
export function NotePanel({
  sessionId,
  session,
  customName,
  onRename,
  onDelete,
  onCloseNote,
  onArchive,
  onClose,
  dock = 'right',
  panelSize,
  onPanelSizeChange,
}: NotePanelProps) {
  const [open, setOpen] = useState(false);
  const horizontal = dock !== 'bottom';
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const saveTimer = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(false);
  const contentRef = useRef('');
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const flushSave = useCallback((keepalive = false): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    if (!dirtyRef.current) return Promise.resolve();
    dirtyRef.current = false;
    setSaveStatus('saving');
    return fetch(`/api/notes/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: contentRef.current }),
      keepalive,
    })
      .then(res => setSaveStatus(res.ok ? 'saved' : 'error'))
      .catch(() => setSaveStatus('error'));
  }, [sessionId]);

  const { editor, openLinkEditor, handleKeyDown, linkBar } = useMarkdownEditor({
    placeholder: 'Start writing… # heading, - list, [ ] todo',
    proseClassName: styles.prose,
    onChange: (markdown) => {
      contentRef.current = markdown;
      dirtyRef.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    fetch(`/api/notes/${encodeURIComponent(sessionId)}`)
      .then(res => res.json())
      .then((data: { content?: string }) => {
        if (cancelled || dirtyRef.current) return;
        const remote = typeof data.content === 'string' ? data.content : '';
        contentRef.current = remote;
        editor.commands.setContent(remote, false);
        setLoaded(true);
        requestAnimationFrame(() => editor.commands.focus('end'));
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [editor, sessionId]);

  // Flush pending edits on unmount and on tab close.
  useEffect(() => {
    const onUnload = () => flushSave(true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      flushSave(true);
    };
  }, [flushSave]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startPos.current = horizontal ? e.clientX : e.clientY;
    startSize.current = panelSize;
    document.body.style.cursor = horizontal ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [panelSize, horizontal]);

  useEffect(() => {
    const min = horizontal ? MIN_WIDTH : MIN_HEIGHT;
    const max = horizontal ? MAX_WIDTH : Math.max(MIN_HEIGHT, window.innerHeight - 160);
    let last = panelSize;
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startPos.current - (horizontal ? e.clientX : e.clientY);
      last = Math.max(min, Math.min(max, startSize.current + delta));
      onPanelSizeChange(last);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(horizontal ? WIDTH_KEY : HEIGHT_KEY, String(last)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizontal, onPanelSizeChange]);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const displayName = customName ?? session?.proposedName ?? 'Untitled note';
  const isClosed = session?.state === 'closed';

  // Save first — archiving drops the live session, and a later PUT would 404.
  const handleArchive = () => {
    if (!onArchive) return;
    void flushSave().then(() => onArchive(sessionId));
  };

  function commitEdit() {
    const trimmed = editValue.trim();
    if (onRename && trimmed && trimmed !== displayName) onRename(sessionId, trimmed);
    setIsEditing(false);
  }

  const statusText =
    saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'error' ? 'Save failed'
    : saveStatus === 'saved' ? 'Saved'
    : formatEdited(session?.lastActivity);

  return (
    <div
      className={`${panelStyles.panel} ${dock === 'bottom' ? panelStyles.panelBottom : ''} ${open ? panelStyles.panelOpen : ''}`}
      style={dock === 'bottom' ? { height: panelSize } : { width: panelSize }}
    >
      <div
        className={`${panelStyles.resizeHandle} ${dock === 'bottom' ? panelStyles.resizeHandleTop : ''}`}
        onMouseDown={onResizeStart}
      />

      <div className={panelStyles.header}>
        {session && (
          <ColorPicker
            sessionId={session.sessionId}
            color={session.color}
            size={34}
            icon={session.icon}
            onChange={(c) => putSessionColor(session.sessionId, c)}
            onIconChange={(i) => putSessionIcon(session.sessionId, i)}
          />
        )}
        <div className={panelStyles.headerLeft}>
          <span className={styles.kind}>Notepad{isClosed ? ' · closed' : ''}</span>
          {isEditing ? (
            <input
              className={panelStyles.nameInput}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              onBlur={commitEdit}
              autoFocus
              maxLength={60}
            />
          ) : (
            <span
              className={`${panelStyles.sessionName} ${onRename ? styles.renamable : ''}`}
              onDoubleClick={() => { if (onRename) { setEditValue(displayName); setIsEditing(true); } }}
              title={onRename ? 'Double-click to rename' : undefined}
            >
              {displayName}
            </span>
          )}
        </div>
        <div className={panelStyles.headerRight}>
          {onCloseNote && !isClosed && (
            <button className={styles.headerBtn} onClick={() => onCloseNote(sessionId)} title="Close note — keeps it in the room, dimmed" aria-label="Close note">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v5.5M4.4 4.2a5 5 0 107.2 0" />
              </svg>
            </button>
          )}
          {onArchive && (
            <button className={styles.headerBtn} onClick={handleArchive} title="Archive note" aria-label="Archive note">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.8" y="2.5" width="12.4" height="3.2" rx="0.8" />
                <path d="M3 5.7v7a1 1 0 001 1h8a1 1 0 001-1v-7M6.5 8.5h3" />
              </svg>
            </button>
          )}
          <button
            className={`${styles.deleteBtn} ${confirmDelete ? styles.deleteBtnConfirm : ''}`}
            onClick={() => (confirmDelete ? onDelete(sessionId) : setConfirmDelete(true))}
            title="Delete note"
            aria-label="Delete note"
          >
            {confirmDelete ? 'Delete?' : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4" />
              </svg>
            )}
          </button>
          {onClose && (
            <button className={panelStyles.closeButton} onClick={onClose} title="Close panel">×</button>
          )}
        </div>
      </div>

      <div className={styles.toolbarRow}>
        <MarkdownToolbar editor={editor} onLink={openLinkEditor} extended />
        {statusText && (
          <span className={`${styles.status} ${saveStatus === 'error' ? styles.statusError : ''}`}>{statusText}</span>
        )}
      </div>
      {linkBar}

      <div className={styles.editorArea} onKeyDown={handleKeyDown}>
        {!loaded && <div className={styles.loading}>Loading…</div>}
        <MarkdownEditorContent editor={editor} hidden={!loaded} className={styles.editorScroll} />
      </div>
    </div>
  );
}
