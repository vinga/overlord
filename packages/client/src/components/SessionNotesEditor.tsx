import { useEffect, useRef, useState } from 'react';
import { useMarkdownEditor, MarkdownToolbar, MarkdownEditorContent, getMarkdown } from './MarkdownEditor';
import styles from './SessionNotesEditor.module.css';

type Mode = 'rich' | 'markdown';
const MODE_KEY = 'overlord.sessionNotesMode';

function loadMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'rich'; } catch { return 'rich'; }
}

interface Props {
  /** Markdown source — the stored session notes. */
  value: string;
  onChange: (markdown: string) => void;
}

/** The session's Notes tab: rich text by default, raw markdown on request.
 *  Both edit the same markdown string; saving stays with the caller. */
export function SessionNotesEditor({ value, onChange }: Props) {
  const [mode, setMode] = useState<Mode>(loadMode);
  // Last markdown the editor emitted — an echo of it must not reset the document
  // (tiptap's round-trip can normalise the text and move the cursor).
  const emittedRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const { editor, openLinkEditor, handleKeyDown, linkBar } = useMarkdownEditor({
    placeholder: 'Describe this session… bold, bullets, links',
    onChange: (markdown) => {
      emittedRef.current = markdown;
      onChangeRef.current(markdown);
    },
  });

  // Load / external changes (session switch, header first-line edit, markdown mode).
  useEffect(() => {
    if (!editor || mode !== 'rich') return;
    if (value === emittedRef.current) return;
    if (getMarkdown(editor) === value) return;
    emittedRef.current = value;
    editor.commands.setContent(value, false);
  }, [editor, value, mode]);

  const switchMode = (next: Mode) => {
    setMode(next);
    emittedRef.current = null;
    try { localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        {mode === 'rich' && <MarkdownToolbar editor={editor} onLink={openLinkEditor} />}
        <div className={styles.modeToggle} role="group" aria-label="Notes editor mode">
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'rich' ? styles.modeActive : ''}`}
            onClick={() => switchMode('rich')}
          >Rich</button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'markdown' ? styles.modeActive : ''}`}
            onClick={() => switchMode('markdown')}
          >Markdown</button>
        </div>
      </div>
      {mode === 'rich' && linkBar}
      {mode === 'rich' ? (
        <div className={styles.editorArea} onKeyDown={handleKeyDown}>
          <MarkdownEditorContent editor={editor} className={styles.editorScroll} />
        </div>
      ) : (
        <textarea
          className={styles.textarea}
          value={value}
          placeholder="Describe this session…"
          onChange={e => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
