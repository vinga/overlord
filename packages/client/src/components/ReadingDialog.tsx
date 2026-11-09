import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './ReadingDialog.module.css';

interface Props {
  title: string;
  /** Next to the title, e.g. a status lozenge. */
  badge?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

/** A centred reading dialog — fixed text width (a readable line length, not a
 *  share of the screen), height up to 80% of the viewport. Esc / backdrop closes.
 *  Used for plans and text pins from the context column. */
export function ReadingDialog({ title, badge, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.dialog} role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
          {badge}
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
