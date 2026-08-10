import React, { useState } from 'react';
import styles from './PrChips.module.css';
import { usePrMeta } from '../hooks/usePrMeta';

interface Props {
  refs: string[];
  sessionId?: string;
}

const VISIBLE = 3;

/** `owner/repo#12` → `{ repo: 'owner/repo', label: '#12' }`. */
function splitRef(ref: string): { repo: string; label: string } {
  const hash = ref.lastIndexOf('#');
  if (hash < 0) return { repo: ref, label: '' };
  return { repo: ref.slice(0, hash), label: ref.slice(hash) };
}

function fallbackUrl(ref: string): string {
  const { repo, label } = splitRef(ref);
  if (!label) return '';
  return `https://github.com/${repo}/pull/${label.slice(1)}`;
}

/** The GitHub pull-request glyph — two branch nodes joined by an arrow. */
function PrGlyph() {
  return (
    <svg className={styles.glyph} width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

export function PrChips({ refs, sessionId }: Props) {
  const meta = usePrMeta();
  const [expanded, setExpanded] = useState(false);
  // Optimistic removal — the chip vanishes on click and comes back if the
  // DELETE fails, rather than waiting a snapshot tick to disappear.
  const [dismissing, setDismissing] = useState<Set<string>>(() => new Set());
  if (!refs || refs.length === 0) return null;

  const shown = refs.filter((r) => !dismissing.has(r));
  if (shown.length === 0) return null;

  const visible = expanded ? shown : shown.slice(0, VISIBLE);
  const overflow = shown.length - VISIBLE;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const dismiss = (e: React.MouseEvent, ref: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sessionId) return;
    setDismissing((prev) => new Set(prev).add(ref));
    void fetch(`/api/sessions/${sessionId}/pr-refs`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    }).then((r) => {
      if (r.ok) return;
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(ref);
        return next;
      });
    }).catch(() => {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(ref);
        return next;
      });
    });
  };

  return (
    <div className={styles.row} onClick={stop}>
      {visible.map((ref) => {
        const m = meta?.[ref];
        const { repo, label } = splitRef(ref);
        // Draft is a distinct visual state, not an extra badge — an open draft
        // reads "DRAFT", never "OPEN DRAFT".
        const state = m?.isDraft && m.state === 'OPEN' ? 'DRAFT' : m?.state;
        const href = m?.url || fallbackUrl(ref);
        return (
          <span key={ref} className={styles.chipWrap}>
            <a
              className={styles.chip}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
              title={m?.title ? `${ref} — ${m.title}` : ref}
            >
              <PrGlyph />
              <span className={styles.chipRef}>{label || ref}</span>
              <span className={styles.chipRepo}>{repo}</span>
              {m?.title && <span className={styles.chipTitle}>{m.title}</span>}
              {state && <span className={styles.state} data-state={state}>{state}</span>}
              {sessionId && (
                <button
                  type="button"
                  className={styles.dismiss}
                  onClick={(e) => dismiss(e, ref)}
                  aria-label={`Dismiss ${ref}`}
                >
                  ×
                </button>
              )}
            </a>
          </span>
        );
      })}
      {!expanded && overflow > 0 && (
        <button
          type="button"
          className={styles.more}
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        >
          +{overflow}
        </button>
      )}
      {expanded && shown.length > VISIBLE && (
        <button
          type="button"
          className={styles.more}
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        >
          show less
        </button>
      )}
    </div>
  );
}
