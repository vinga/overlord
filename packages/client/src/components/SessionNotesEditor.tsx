import { useState } from 'react';
import { RichMarkdownPane } from './FileEditorOverlay';
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

/** The session's Notes tab: the file editor's rich pane (headings, lists,
 *  quotes, code — same look) by default, raw markdown on request. Both edit
 *  the same markdown string; saving stays with the caller. */
export function SessionNotesEditor({ value, onChange }: Props) {
  const [mode, setMode] = useState<Mode>(loadMode);

  const switchMode = (next: Mode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  };

  return (
    <div className={styles.root}>
      <div className={styles.modeRow}>
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
      {mode === 'rich' ? (
        <div className={styles.richArea}>
          <RichMarkdownPane
            content={value}
            onChange={onChange}
            placeholder="Describe this session… headings, bullets, links"
          />
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
