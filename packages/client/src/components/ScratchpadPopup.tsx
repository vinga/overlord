import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
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

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: 'Jot anything… bold, bullets, links' }),
      Markdown.configure({ html: false, linkify: true, breaks: true }),
    ],
    editorProps: {
      attributes: { class: styles.prose, spellcheck: 'false' },
      // Click opens links; place the cursor via adjacent text or arrow keys.
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest('a');
        if (anchor?.href) {
          window.open(anchor.href, '_blank', 'noopener');
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      contentRef.current = e.storage.markdown.getMarkdown();
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
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
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

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);

  const openLinkEditor = useCallback(() => {
    if (!editor) return;
    setLinkUrl(editor.getAttributes('link').href ?? '');
    setLinkOpen(true);
  }, [editor]);

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
  }, [editor, linkUrl]);

  const removeLink = useCallback(() => {
    setLinkOpen(false);
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
  }, [editor]);

  const handlePopupKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openLinkEditor();
    }
  }, [openLinkEditor]);

  const toolBtn = (active: boolean) =>
    `${styles.toolBtn} ${active ? styles.toolBtnActive : ''}`;

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
      {open && (
        <div className={`${styles.popup} ${large ? styles.popupLarge : ''}`} role="dialog" aria-label="Scratchpad" onKeyDown={handlePopupKeyDown}>
          <div className={styles.popupHeader}>
            <span className={styles.popupTitle}>Scratchpad</span>
            <div className={styles.toolbar}>
              <button
                className={toolBtn(!!editor?.isActive('bold'))}
                onMouseDown={e => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleBold().run()}
                title="Bold (⌘B)"
                aria-label="Bold"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 2.5h5a2.5 2.5 0 010 5h-5zM4.5 7.5h5.8a2.7 2.7 0 010 5.4H4.5z" />
                </svg>
              </button>
              <button
                className={toolBtn(!!editor?.isActive('italic'))}
                onMouseDown={e => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                title="Italic (⌘I)"
                aria-label="Italic"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M6.5 2.5h6M3.5 13.5h6M9.5 2.5l-3 11" />
                </svg>
              </button>
              <button
                className={toolBtn(!!editor?.isActive('bulletList'))}
                onMouseDown={e => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                title="Bullet list"
                aria-label="Bullet list"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M6 3.5h8M6 8h8M6 12.5h8" />
                  <circle cx="2.7" cy="3.5" r="1" fill="currentColor" stroke="none" />
                  <circle cx="2.7" cy="8" r="1" fill="currentColor" stroke="none" />
                  <circle cx="2.7" cy="12.5" r="1" fill="currentColor" stroke="none" />
                </svg>
              </button>
              <button
                className={toolBtn(!!editor?.isActive('link'))}
                onMouseDown={e => e.preventDefault()}
                onClick={openLinkEditor}
                title="Link (⌘K)"
                aria-label="Link"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6.5 9.5a3 3 0 004.3.2l2.3-2.3a3 3 0 00-4.2-4.2L7.6 4.5" />
                  <path d="M9.5 6.5a3 3 0 00-4.3-.2L2.9 8.6a3 3 0 004.2 4.2l1.3-1.3" />
                </svg>
              </button>
              <button
                className={toolBtn(!!editor?.isActive('taskList'))}
                onMouseDown={e => e.preventDefault()}
                onClick={() => editor?.chain().focus().toggleTaskList().run()}
                title="Todo list"
                aria-label="Todo list"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
                  <path d="M3 4l1.2 1.2L6.5 2.8M9.5 4h5M9.5 12h5" />
                  <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
                </svg>
              </button>
            </div>
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
          {linkOpen && (
            <div className={styles.linkBar}>
              <input
                ref={linkInputRef}
                className={styles.linkInput}
                placeholder="https://…"
                value={linkUrl}
                onChange={e => setLinkUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyLink();
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setLinkOpen(false);
                    editor?.commands.focus();
                  }
                }}
                spellCheck={false}
              />
              <button className={styles.linkApply} onClick={applyLink}>Apply</button>
              <button className={styles.headerIconBtn} onClick={removeLink} title="Remove link" aria-label="Remove link">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}
          {!loaded && <div className={styles.loading}>Loading…</div>}
          <EditorContent editor={editor} className={`${styles.editorScroll} ${loaded ? '' : styles.hidden}`} />
        </div>
      )}
    </div>
  );
}
