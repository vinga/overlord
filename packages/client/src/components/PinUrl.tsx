import React, { useEffect, useRef, useState } from 'react';
import styles from './CopyUrl.module.css';

/**
 * Pin icon for a detected (not yet pinned) ticket or PR chip: one click pins
 * its URL to the session. Same look as CopyUrl — hidden until the chip is
 * hovered, never follows the link.
 */
export function PinUrl({ url, overlordId }: { url: string | undefined; overlordId: string | undefined }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!url || !overlordId) return null;
  const flash = (s: 'done' | 'error') => {
    setState(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  const pin = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === 'busy') return;
    setState('busy');
    fetch('/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overlordId, url }),
    }).then(r => flash(r.ok ? 'done' : 'error')).catch(() => flash('error'));
  };
  const label = state === 'done' ? 'Pinned' : state === 'error' ? 'Pin failed' : 'Pin to this session';
  return (
    <span
      className={styles.copy}
      data-copied={state === 'done' || undefined}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={pin}
      onMouseDown={e => e.stopPropagation()}
      onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') pin(e); }}
    >
      {state === 'done' ? (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M3 8.5 6.5 12 13 4.5" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-20deg)' }}>
          <path d="M6 1.75h4M7 1.75v4.5L4.5 9h7L9 6.25v-4.5M8 9v5.25" />
        </svg>
      )}
    </span>
  );
}
