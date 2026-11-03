import React, { useEffect, useRef, useState } from 'react';
import type { Pin, PinKind } from '../types';
import styles from './PinBar.module.css';

/** Who the pins belong to — a session (by overlordId) or a room (by cwd). */
type PinTarget = { overlordId: string } | { cwd: string };

/** Exactly one of overlordId / cwd. Primitives, not a target object, so the
 *  React.memo shallow compare holds across WebSocket ticks. */
type Props = { pins: Pin[] | undefined } & (
  | { overlordId: string; cwd?: undefined }
  | { cwd: string; overlordId?: undefined }
);

function targetQuery(target: PinTarget): string {
  return 'overlordId' in target
    ? `overlordId=${encodeURIComponent(target.overlordId)}`
    : `cwd=${encodeURIComponent(target.cwd)}`;
}

/** Octicon-style 16px glyphs, filled with currentColor. */
function KindIcon({ kind }: { kind: PinKind }) {
  const common = {
    className: styles.icon,
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': true,
  } as const;
  switch (kind) {
    case 'pr':
      return (
        <svg {...common}>
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </svg>
      );
    case 'branch':
      return (
        <svg {...common}>
          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
        </svg>
      );
    case 'ticket':
      return (
        <svg {...common}>
          <path d="M1.5 4.25c0-.966.784-1.75 1.75-1.75h9.5c.966 0 1.75.784 1.75 1.75v1.5a.75.75 0 0 1-.75.75 1.5 1.5 0 0 0 0 3 .75.75 0 0 1 .75.75v1.5a1.75 1.75 0 0 1-1.75 1.75h-9.5a1.75 1.75 0 0 1-1.75-1.75v-1.5a.75.75 0 0 1 .75-.75 1.5 1.5 0 0 0 0-3 .75.75 0 0 1-.75-.75Zm1.75-.25a.25.25 0 0 0-.25.25v.946a3.001 3.001 0 0 1 0 5.608v.946c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-.946a3.001 3.001 0 0 1 0-5.608V4.25a.25.25 0 0 0-.25-.25Zm7.5 1.25v5.5a.75.75 0 0 1-1.5 0v-5.5a.75.75 0 0 1 1.5 0Z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z" />
        </svg>
      );
  }
}

/** Links pinned to a session or a room — one row of chips above the tab bar.
 *  Hidden when empty (the first pin is added via the CLI). The snapshot
 *  rebroadcasts after every change, so there is no local copy of the list. */
export const PinBar = React.memo(function PinBar({ pins, overlordId, cwd }: Props) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const target: PinTarget = overlordId !== undefined ? { overlordId } : { cwd: cwd as string };
  const targetKey = overlordId ?? cwd;

  // A different session/room — drop any half-typed draft.
  useEffect(() => {
    setAdding(false);
    setUrl('');
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  if (!pins || pins.length === 0) return null;

  const cancel = () => {
    setAdding(false);
    setUrl('');
    setError(null);
  };

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, url: trimmed }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? `Failed (${r.status})`);
        return;
      }
      cancel();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const remove = (e: React.MouseEvent, pinId: string) => {
    e.preventDefault();
    e.stopPropagation();
    void fetch(`/api/pins/${encodeURIComponent(pinId)}?${targetQuery(target)}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        {pins.map((pin) => (
          <span key={pin.id} className={styles.chip} data-kind={pin.kind}>
            <a
              className={styles.link}
              href={pin.url}
              target="_blank"
              rel="noopener noreferrer"
              title={pin.url}
            >
              <KindIcon kind={pin.kind} />
              <span className={styles.label}>{pin.title || pin.url}</span>
            </a>
            <button
              type="button"
              className={styles.remove}
              onClick={(e) => remove(e, pin.id)}
              aria-label={`Unpin ${pin.title || pin.url}`}
              title="Unpin"
            >
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <input
            ref={inputRef}
            className={`${styles.input} ${error ? styles.inputError : ''}`}
            value={url}
            placeholder="Paste a URL…"
            disabled={busy}
            onChange={(e) => { setUrl(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
            onBlur={() => { if (!url.trim()) cancel(); }}
          />
        ) : (
          <button
            type="button"
            className={styles.add}
            onClick={() => setAdding(true)}
            title="Pin a link"
            aria-label="Pin a link"
          >
            +
          </button>
        )}
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
});
