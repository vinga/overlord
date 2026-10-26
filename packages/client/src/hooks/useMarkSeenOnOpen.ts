import { useEffect, useRef } from 'react';
import type { Room } from '../types';
import { needsUser } from '../lib/sessionAttention';

/**
 * Opening a session that is waiting on the user marks it `review: 'read'` on
 * the server — persisted, and cleared by the server when the next turn starts.
 * Also fires when the open session starts waiting while you're looking at it.
 */
export function useMarkSeenOnOpen(rooms: Room[], selectedSessionId: string | null | undefined): void {
  let target: string | null = null;
  if (selectedSessionId) {
    for (const r of rooms) {
      const s = r.sessions.find(x => x.overlordId === selectedSessionId || x.sessionId === selectedSessionId);
      if (s) {
        if (needsUser(s) && s.review == null) target = s.sessionId;
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
