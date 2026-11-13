import React, { useEffect, useRef, useState } from 'react';
import styles from './CopyUrl.module.css';

/**
 * Copy-link icon. Inline (default) it sits inside a chip's link, hidden until
 * the chip is hovered, and never follows the link. `className` replaces the
 * inline look (e.g. a hover card's header icon button), always visible.
 */
export function CopyUrl({ url, className, label = 'Copy link' }: { url: string | undefined; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!url) return null;
  const copy = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <span
      className={className ?? styles.copy}
      data-copied={copied || undefined}
      role="button"
      tabIndex={0}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : `${label}\n${url}`}
      onClick={copy}
      onMouseDown={e => e.stopPropagation()}
      onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') copy(e); }}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M3 8.5 6.5 12 13 4.5" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
        </svg>
      )}
    </span>
  );
}
