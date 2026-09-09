import { useEffect } from 'react';
import ReactDOM from 'react-dom';
import styles from './BtwToast.module.css';

/** How long an answered toast stays before it dismisses itself. */
export const BTW_TOAST_TTL_MS = 60_000;

export interface BtwEntry {
  id: number;
  question: string;
  /** Undefined while the internal agent is still working. */
  answer?: string;
  error?: string;
}

interface BtwToastProps {
  entry: BtwEntry;
  onDismiss: (id: number) => void;
}

function BtwToast({ entry, onDismiss }: BtwToastProps) {
  const settled = entry.answer !== undefined || entry.error !== undefined;

  // Pending toasts stay until the answer lands; the 60s clock starts then.
  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => onDismiss(entry.id), BTW_TOAST_TTL_MS);
    return () => clearTimeout(t);
  }, [settled, entry.id, onDismiss]);

  return (
    <div
      className={`${styles.toast} ${entry.error ? styles.error : ''}`}
      onClick={() => onDismiss(entry.id)}
      role="status"
      title="Click to dismiss"
    >
      <span className={styles.icon}>
        {!settled ? (
          <span className={styles.spinner} />
        ) : entry.error ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>
        )}
      </span>
      <div className={styles.body}>
        <div className={styles.question}>{entry.question}</div>
        {!settled ? (
          <div className={`${styles.answer} ${styles.pending}`}>Thinking…</div>
        ) : entry.error ? (
          <div className={styles.answer}>Couldn't answer: {entry.error}</div>
        ) : (
          <div className={styles.answer}>{entry.answer}</div>
        )}
      </div>
    </div>
  );
}

interface BtwToastStackProps {
  entries: BtwEntry[];
  onDismiss: (id: number) => void;
}

/** Top-right stack of `/btw` answers. Portaled so header overflow can't clip it. */
export function BtwToastStack({ entries, onDismiss }: BtwToastStackProps) {
  if (entries.length === 0) return null;
  return ReactDOM.createPortal(
    <div className={styles.stack}>
      {entries.map(e => <BtwToast key={e.id} entry={e} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  );
}
