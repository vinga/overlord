import React, { useEffect, useRef, useState } from 'react';
import styles from './CopyUrl.module.css';

/** "Name this session after the ticket" icon, inside a ticket chip's link:
 *  hidden until the chip is hovered, never follows the link. */
export function SetTitleIcon({ onSet, ticketKey }: { onSet: () => void; ticketKey: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const set = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSet();
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1500);
  };
  const label = `Name this session after ${ticketKey}`;
  return (
    <span
      className={styles.copy}
      data-copied={done || undefined}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={done ? 'Session renamed' : label}
      onClick={set}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') set(e); }}
    >
      {done ? (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M3 8.5 6.5 12 13 4.5" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 3.5h7M6 3.5v9" />
          <path d="M9.5 13.5l.6-2.2 3.6-3.6a1 1 0 0 1 1.4 1.4l-3.6 3.6-2 .8Z" />
        </svg>
      )}
    </span>
  );
}
