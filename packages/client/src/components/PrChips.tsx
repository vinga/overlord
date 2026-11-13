import React, { useState } from 'react';
import styles from './PrChips.module.css';
import { usePrMeta } from '../hooks/usePrMeta';

interface Props {
  refs: string[];
  sessionId?: string;
  /** Full-width cards: #number + state on the first line, repo and title below. */
  card?: boolean;
  /** Pinned refs (lowercased) → unpin. Their × unpins instead of dismissing. */
  pinned?: ReadonlyMap<string, () => void>;
}

const VISIBLE = 3;

/** `owner/repo#12` → `{ repo: 'owner/repo', label: '#12' }`. */
function splitRef(ref: string): { repo: string; label: string } {
  const hash = ref.lastIndexOf('#');
  if (hash < 0) return { repo: ref, label: '' };
  return { repo: ref.slice(0, hash), label: ref.slice(hash) };
}

/** `https://github.com/o/r/pull/12` → `o/r#12`, case kept (prMeta keys keep it). */
export function prRefFromUrl(url: string | undefined): string | undefined {
  const m = url?.match(/^https?:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}#${m[2]}` : undefined;
}

function fallbackUrl(ref: string): string {
  const { repo, label } = splitRef(ref);
  if (!label) return '';
  return `https://github.com/${repo}/pull/${label.slice(1)}`;
}

/** The GitHub pull-request glyph — two branch nodes joined by an arrow. */
export function PrGlyph() {
  return (
    <svg className={styles.glyph} width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

/** Marks a pinned PR card. */
function PinGlyph() {
  return (
    <svg className={styles.pinGlyph} width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-label="Pinned">
      <title>Pinned</title>
      <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
    </svg>
  );
}

export function PrChips({ refs, sessionId, card = false, pinned }: Props) {
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
    const unpin = pinned?.get(ref.toLowerCase());
    if (unpin) {
      // The pin's DELETE drops it from the snapshot; hide it until then.
      setDismissing((prev) => new Set(prev).add(ref));
      unpin();
      return;
    }
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
    <div className={`${styles.row} ${card ? styles.card : ''}`} onClick={stop}>
      {visible.map((ref) => {
        const m = meta?.[ref];
        const { repo, label } = splitRef(ref);
        // Draft is a distinct visual state, not an extra badge — an open draft
        // reads "DRAFT", never "OPEN DRAFT".
        const state = m?.isDraft && m.state === 'OPEN' ? 'DRAFT' : m?.state;
        const href = m?.url || fallbackUrl(ref);
        const isPinned = !!pinned?.has(ref.toLowerCase());
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
              {isPinned && <PinGlyph />}
              <span className={styles.chipRepo}>{repo}</span>
              {m?.title && <span className={styles.chipTitle}>{m.title}</span>}
              {state && <span className={styles.state} data-state={state}>{state}</span>}
              {(sessionId || isPinned) && (
                <button
                  type="button"
                  className={styles.dismiss}
                  onClick={(e) => dismiss(e, ref)}
                  aria-label={isPinned ? `Unpin ${ref}` : `Dismiss ${ref}`}
                  title={isPinned ? 'Unpin' : 'Dismiss'}
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
