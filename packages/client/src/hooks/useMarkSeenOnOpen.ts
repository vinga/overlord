import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Room } from '../types';
import { turnEnded } from '../lib/sessionAttention';

/** The window is in front of the user: tab visible and window focused. */
function isLooking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function subscribeLooking(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  window.addEventListener('focus', cb);
  window.addEventListener('blur', cb);
  return () => {
    document.removeEventListener('visibilitychange', cb);
    window.removeEventListener('focus', cb);
    window.removeEventListener('blur', cb);
  };
}

/**
 * Opening a session that is waiting on the user marks it `review: 'read'` on
 * the server — persisted, and cleared by the server when the next turn starts.
 * Also fires when the open session starts waiting while you're looking at it.
 * Only while the window is visible and focused: a turn that ends while you're
 * in another tab or app stays unseen until you come back.
 */
export function useMarkSeenOnOpen(rooms: Room[], selectedSessionId: string | null | undefined): void {
  const looking = useSyncExternalStore(subscribeLooking, isLooking);
  let target: string | null = null;
  if (selectedSessionId && looking) {
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
  useEffect(() => {
    if (!target) { sentRef.current = null; return; }
    if (sentRef.current === target) return;
    sentRef.current = target;
    void fetch(`/api/sessions/${target}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review: 'read' }),
    }).catch(() => { sentRef.current = null; });
  }, [target]);
}
