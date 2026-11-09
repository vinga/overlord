import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConversationPinner.module.css';

interface Props {
  /** The conversation feed; only links inside it count. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Session the pins go to. */
  overlordId: string;
}

type Target = { url: string; x: number; y: number };

const LINK_HIDE_MS = 180;

/** POST a pin to the session — a URL, or `{ text }` for a text pin.
 *  Resolves to an error message, or null when pinned. */
export async function pinToSession(overlordId: string, what: { url: string } | { text: string }): Promise<string | null> {
  const body = 'text' in what ? { overlordId, kind: 'text', text: what.text } : { overlordId, url: what.url };
  try {
    const r = await fetch('/api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    const j = await r.json().catch(() => ({})) as { error?: string };
    return j.error ?? `Error ${r.status}`;
  } catch (err) {
    return String(err);
  }
}

/**
 * A small 📌 button beside a hovered link in the conversation feed; click pins
 * the URL to the session. (Selected text is pinned from SelectionMenu.)
 * Delegated listeners on the feed — no per-link handlers.
 */
export function ConversationPinner({ containerRef, overlordId }: Props) {
  const [target, setTarget] = useState<Target | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHide = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  const hideSoon = useCallback((ms = LINK_HIDE_MS) => {
    clearHide();
    hideTimer.current = setTimeout(() => { setTarget(null); setFlash(null); }, ms);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onOver = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="http"]') as HTMLAnchorElement | null;
      if (!a || !container.contains(a)) return;
      clearHide();
      const rect = a.getBoundingClientRect();
      setFlash(null);
      setTarget({ url: a.href, x: rect.right + 4, y: rect.top + rect.height / 2 });
    };
    const onOut = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('a[href^="http"]')) hideSoon();
    };
    const onScroll = () => { clearHide(); setTarget(null); setFlash(null); };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      container.removeEventListener('scroll', onScroll);
    };
    // overlordId: a session switch remounts the feed — re-bind to the new node.
  }, [containerRef, hideSoon, overlordId]);

  useEffect(() => () => clearHide(), []);

  if (!target) return null;

  const pin = async () => {
    const err = await pinToSession(overlordId, { url: target.url });
    setFlash(err ? `Not pinned: ${err}` : 'Pinned');
    hideSoon(err ? 2500 : 900);
  };

  return createPortal(
    <button
      type="button"
      className={`${styles.pin} ${flash ? styles.flash : ''}`}
      style={{ left: target.x, top: target.y, transform: 'translateY(-50%)' }}
      onMouseEnter={clearHide}
      onMouseLeave={() => { if (!flash) hideSoon(); }}
      onClick={() => { if (!flash) void pin(); }}
      title={`Pin ${target.url}`}
      aria-label="Pin link"
    >
      {flash ?? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 2.5l4 4-2 1-2.5 2.5-.5 3-1-1L5 8.5l-1-1 3-.5L9.5 4.5z" />
          <line x1="5.2" y1="10.8" x2="2" y2="14" />
        </svg>
      )}
    </button>,
    document.body,
  );
}
