import { useEffect, useRef } from 'react';
import type { Room } from '../types';
import { turnEnded } from '../lib/sessionAttention';

/** The window is in front of the user: tab visible and window focused. */
function isLooking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

const INTERACTIONS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

function markRead(sessionId: string): Promise<unknown> {
  return fetch(`/api/sessions/${sessionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review: 'read' }),
  });
}

/**
 * Marks the open session `review: 'read'` on the server once its finished
 * turn has really been seen — persisted, cleared by the server when the next
 * turn starts.
 * - Opening a finished session (selection change, window in front) marks it at once.
 * - A turn that ends in the already-open session, or while you're in another
 *   tab or app, stays unseen until you interact with the window (move the
 *   mouse, click, type, scroll) — so coming back shows the violet dot first.
 */
export function useMarkSeenOnOpen(rooms: Room[], selectedSessionId: string | null | undefined): void {
  let target: string | null = null;
  if (selectedSessionId) {
    for (const r of rooms) {
      const s = r.sessions.find(x => x.overlordId === selectedSessionId || x.sessionId === selectedSessionId);
      if (s) {
        if (turnEnded(s) && s.review == null) target = s.sessionId;
        break;
      }
    }
  }

  // The snapshot reflects the write a tick later — don't POST twice meanwhile.
  const sentRef = useRef<string | null>(null);
  const prevSelectedRef = useRef(selectedSessionId);
  useEffect(() => {
    const justOpened = prevSelectedRef.current !== selectedSessionId;
    prevSelectedRef.current = selectedSessionId;
    if (!target) { sentRef.current = null; return; }
    if (sentRef.current === target) return;
    const id = target;
    const send = () => {
      if (sentRef.current === id) return;
      sentRef.current = id;
      markRead(id).catch(() => { sentRef.current = null; });
    };
    if (justOpened && isLooking()) { send(); return; }
    const onInteract = () => { if (isLooking()) send(); };
    for (const ev of INTERACTIONS) window.addEventListener(ev, onInteract, { passive: true, capture: true });
    return () => {
      for (const ev of INTERACTIONS) window.removeEventListener(ev, onInteract, { capture: true });
    };
  }, [target, selectedSessionId]);
}
