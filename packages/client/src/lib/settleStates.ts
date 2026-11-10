import type { OfficeSnapshot, Session } from '../types';

/** How long a session must stay 'waiting' after working before the UI shows it.
 *  Between tool calls the transcript briefly reads as idle while the agent keeps
 *  going; without this the badge flickers WORKING → WAITING → WORKING. */
export const WAITING_HOLD_MS = 4000;

type Active = 'working' | 'thinking';

/** Display hysteresis for session state. `lastActive` maps a session key to when
 *  it was last seen working/thinking (and which); it is updated in place.
 *  A 'waiting' session seen active within WAITING_HOLD_MS keeps showing its last
 *  active state — unless it is asking the user something (permission, question,
 *  limit prompt), which must show at once.
 *  Returns `next` itself when nothing is held, plus the earliest moment a held
 *  state expires so the caller can re-run then. */
export function settleStates(
  next: OfficeSnapshot,
  lastActive: Map<string, { at: number; state: Active }>,
  now: number,
): { snapshot: OfficeSnapshot; recheckAt?: number } {
  let recheckAt: number | undefined;
  let roomsChanged = false;
  const rooms = next.rooms.map((room) => {
    let changed = false;
    const sessions = room.sessions.map((s) => {
      const key = s.overlordId ?? s.sessionId;
      if (s.state === 'working' || s.state === 'thinking') {
        lastActive.set(key, { at: now, state: s.state });
        return s;
      }
      const seen = lastActive.get(key);
      if (s.state !== 'waiting' || !seen) return s;
      const until = seen.at + WAITING_HOLD_MS;
      if (now >= until || asksUser(s)) { lastActive.delete(key); return s; }
      recheckAt = recheckAt === undefined ? until : Math.min(recheckAt, until);
      changed = true;
      return { ...s, state: seen.state };
    });
    if (!changed) return room;
    roomsChanged = true;
    return { ...room, sessions };
  });
  return { snapshot: roomsChanged ? { ...next, rooms } : next, recheckAt };
}

function asksUser(s: Session): boolean {
  return !!(s.needsPermission || s.isLimitPrompt || (s.pendingQuestion && !s.questionStale));
}
