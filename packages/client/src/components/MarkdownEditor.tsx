import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
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
import styles from './MarkdownEditor.module.css';

/** Markdown of the editor's current document (tiptap-markdown storage). */
export function getMarkdown(editor: Editor): string {
  return editor.storage.markdown.getMarkdown();
}

interface Options {
  placeholder: string;
  /** Extra class on the ProseMirror root — e.g. a larger font size. */
  proseClassName?: string;
  onChange: (markdown: string) => void;
}

/**
 * WYSIWYG markdown editor shared by the header Scratchpad and notepad sessions:
 * tiptap + tiptap-markdown, a formatting toolbar and an inline link bar (⌘K).
 */
export function useMarkdownEditor({ placeholder, proseClassName, onChange }: Options) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
      Placeholder.configure({ placeholder }),
      Markdown.configure({ html: false, linkify: true, breaks: true }),
    ],
    editorProps: {
      attributes: { class: `${styles.prose} ${proseClassName ?? ''}`, spellcheck: 'false' },
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
    onUpdate: ({ editor: e }) => onChangeRef.current(getMarkdown(e)),
  });

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

  /** Attach to the editor's container: ⌘K opens the link bar. */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openLinkEditor();
    }
  }, [openLinkEditor]);

  const linkBar = linkOpen && (
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
      <button className={styles.toolBtn} onClick={removeLink} title="Remove link" aria-label="Remove link">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );

  return { editor, openLinkEditor, handleKeyDown, linkBar };
}

function ToolBtn({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={`${styles.toolBtn} ${active ? styles.toolBtnActive : ''}`}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-label={title.replace(/\s*\(.*\)$/, '')}
    >
      {children}
    </button>
  );
}

/** Formatting buttons. `extended` adds headings, numbered list, quote and code block. */
export function MarkdownToolbar({ editor, onLink, extended = false, className }: {
  editor: Editor | null;
  onLink: () => void;
  extended?: boolean;
  className?: string;
}) {
  const chain = () => editor?.chain().focus();
  const is = (name: string, attrs?: Record<string, unknown>) => !!editor?.isActive(name, attrs);
  // Scratchpad keeps its original order (link before todo); extended puts it last.
  const linkBtn = (
    <ToolBtn active={is('link')} title="Link (⌘K)" onClick={onLink}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 9.5a3 3 0 004.3.2l2.3-2.3a3 3 0 00-4.2-4.2L7.6 4.5" />
        <path d="M9.5 6.5a3 3 0 00-4.3-.2L2.9 8.6a3 3 0 004.2 4.2l1.3-1.3" />
      </svg>
    </ToolBtn>
  );
  return (
    <div className={`${styles.toolbar} ${className ?? ''}`}>
      {extended && (
        <>
          <ToolBtn active={is('heading', { level: 1 })} title="Heading 1" onClick={() => chain()?.toggleHeading({ level: 1 }).run()}>
            <span className={styles.toolText}>H1</span>
          </ToolBtn>
          <ToolBtn active={is('heading', { level: 2 })} title="Heading 2" onClick={() => chain()?.toggleHeading({ level: 2 }).run()}>
            <span className={styles.toolText}>H2</span>
          </ToolBtn>
          <span className={styles.toolSep} />
        </>
      )}
      <ToolBtn active={is('bold')} title="Bold (⌘B)" onClick={() => chain()?.toggleBold().run()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 2.5h5a2.5 2.5 0 010 5h-5zM4.5 7.5h5.8a2.7 2.7 0 010 5.4H4.5z" />
        </svg>
      </ToolBtn>
      <ToolBtn active={is('italic')} title="Italic (⌘I)" onClick={() => chain()?.toggleItalic().run()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6.5 2.5h6M3.5 13.5h6M9.5 2.5l-3 11" />
        </svg>
      </ToolBtn>
      {extended && (
        <ToolBtn active={is('strike')} title="Strikethrough (⌘⇧S)" onClick={() => chain()?.toggleStrike().run()}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 8h11M11 4.5C10.5 3.3 9.4 2.5 8 2.5c-1.9 0-3.2 1-3.2 2.4 0 .9.5 1.6 1.4 2M5 11.5c.5 1.2 1.6 2 3.2 2 1.9 0 3.2-1 3.2-2.4 0-.5-.1-.9-.4-1.3" />
          </svg>
        </ToolBtn>
      )}
      <ToolBtn active={is('bulletList')} title="Bullet list" onClick={() => chain()?.toggleBulletList().run()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6 3.5h8M6 8h8M6 12.5h8" />
          <circle cx="2.7" cy="3.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="2.7" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="2.7" cy="12.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      </ToolBtn>
      {extended && (
        <ToolBtn active={is('orderedList')} title="Numbered list" onClick={() => chain()?.toggleOrderedList().run()}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M6.5 3.5h7.5M6.5 8h7.5M6.5 12.5h7.5" />
            <text x="0.6" y="5.4" fontSize="5" fill="currentColor" stroke="none" fontFamily="Inter,system-ui,sans-serif">1</text>
            <text x="0.6" y="9.9" fontSize="5" fill="currentColor" stroke="none" fontFamily="Inter,system-ui,sans-serif">2</text>
            <text x="0.6" y="14.4" fontSize="5" fill="currentColor" stroke="none" fontFamily="Inter,system-ui,sans-serif">3</text>
          </svg>
        </ToolBtn>
      )}
      {!extended && linkBtn}
      <ToolBtn active={is('taskList')} title="Todo list" onClick={() => chain()?.toggleTaskList().run()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
          <path d="M3 4l1.2 1.2L6.5 2.8M9.5 4h5M9.5 12h5" />
          <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
        </svg>
      </ToolBtn>
      {extended && (
        <>
          <ToolBtn active={is('blockquote')} title="Quote" onClick={() => chain()?.toggleBlockquote().run()}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 2.5v11M6 4.5h7.5M6 8h7.5M6 11.5h5" />
            </svg>
          </ToolBtn>
          <ToolBtn active={is('codeBlock')} title="Code block" onClick={() => chain()?.toggleCodeBlock().run()}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
            </svg>
          </ToolBtn>
        </>
      )}
      {extended && linkBtn}
    </div>
  );
}

/** Scrollable editor surface. `hidden` keeps the editor mounted while content loads. */
export function MarkdownEditorContent({ editor, hidden, className }: { editor: Editor | null; hidden?: boolean; className?: string }) {
  return (
    <EditorContent
      editor={editor}
      className={`${styles.editorScroll} ${className ?? ''} ${hidden ? styles.hidden : ''}`}
    />
  );
}
