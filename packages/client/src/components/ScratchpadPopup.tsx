import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMarkdownEditor, MarkdownToolbar, MarkdownEditorContent } from './MarkdownEditor';
import styles from './ScratchpadPopup.module.css';

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 300;
const SAVE_DEBOUNCE_MS = 800;

export function ScratchpadPopup() {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [large, setLarge] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(false);
  const contentRef = useRef('');

  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    fetch('/api/scratchpad', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: contentRef.current }),
    })
      .then(res => setSaveError(!res.ok))
      .catch(() => setSaveError(true));
  }, []);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const { editor, openLinkEditor, handleKeyDown: handlePopupKeyDown, linkBar } = useMarkdownEditor({
    placeholder: 'Jot anything… bold, bullets, links',
    onChange: (markdown) => {
      contentRef.current = markdown;
      scheduleSave();
    },
  });

  // Load on open; refresh unless there are unsaved edits.
  useEffect(() => {
    if (!open || !editor || dirtyRef.current) return;
    fetch('/api/scratchpad')
      .then(res => res.json())
      .then((data: { content?: string }) => {
        if (dirtyRef.current) return;
        const remote = typeof data.content === 'string' ? data.content : '';
        contentRef.current = remote;
        editor.commands.setContent(remote, false);
        setLoaded(true);
        requestAnimationFrame(() => editor.commands.focus('end'));
      })
      .catch(() => setLoaded(true));
  }, [open, editor]);

  const close = useCallback(() => {
    setOpen(false);
    setPinned(false);
    flushSave();
  }, [flushSave]);

  // Escape closes; outside click closes when pinned.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      close();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, close]);

  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    flushSave();
  }, [flushSave]);

  const handleMouseEnter = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    if (!open) openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, [open]);

  const handleMouseLeave = useCallback(() => {
    window.clearTimeout(openTimer.current);
    if (open && !pinned) closeTimer.current = window.setTimeout(close, CLOSE_DELAY_MS);
  }, [open, pinned, close]);

  const handleTriggerClick = useCallback(() => {
    if (open && pinned) {
      close();
    } else {
      window.clearTimeout(openTimer.current);
      setOpen(true);
      setPinned(true);
    }
  }, [open, pinned, close]);

  // Large mode portals to <body> to escape the sticky header's backdrop-filter
  // containing block, so hover open/close needs handlers on the popup itself.
  const popup = open && (
    <div
      ref={popupRef}
      className={`${styles.popup} ${large ? styles.popupLarge : ''}`}
      role="dialog"
      aria-label="Scratchpad"
      onKeyDown={handlePopupKeyDown}
      onMouseEnter={large ? handleMouseEnter : undefined}
      onMouseLeave={large ? handleMouseLeave : undefined}
    >
          <div className={styles.popupHeader}>
            <span className={styles.popupTitle}>Scratchpad</span>
            <MarkdownToolbar editor={editor} onLink={openLinkEditor} className={styles.toolbar} />
            {saveError && <span className={styles.saveError}>save failed</span>}
            <button
              className={styles.headerIconBtn}
              onClick={() => setLarge(l => !l)}
              title={large ? 'Shrink' : 'Expand'}
              aria-label={large ? 'Shrink scratchpad' : 'Expand scratchpad'}
            >
              {large ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 2v4H2M10 14v-4h4" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2L9 7M2 14l5-5" />
                </svg>
              )}
            </button>
            <button className={styles.headerIconBtn} onClick={close} title="Close" aria-label="Close scratchpad">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {linkBar}
      {!loaded && <div className={styles.loading}>Loading…</div>}
      <MarkdownEditorContent editor={editor} hidden={!loaded} />
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        className={styles.triggerBtn}
        onClick={handleTriggerClick}
        title="Scratchpad"
        aria-label="Scratchpad"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11.5 1.9l2.6 2.6L5.4 13.2l-3.3.7.7-3.3z" />
          <path d="M9.8 3.6l2.6 2.6" />
        </svg>
      </button>
      {large ? createPortal(popup, document.body) : popup}
    </div>
  );
}
