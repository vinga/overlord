import { describe, it, expect } from 'vitest';
import { settleStates, WAITING_HOLD_MS } from '../settleStates';
import type { OfficeSnapshot, Session } from '../../types';

const snap = (...sessions: Partial<Session>[]): OfficeSnapshot => ({
  rooms: [{ id: 'r', name: 'r', cwd: '/r', sessions: sessions.map(s => ({ sessionId: 's1', state: 'waiting', ...s })) }],
} as unknown as OfficeSnapshot);

const stateOf = (s: OfficeSnapshot) => s.rooms[0].sessions[0].state;

describe('settleStates', () => {
  it('holds a working session as working through a short waiting blip', () => {
    const seen = new Map();
    settleStates(snap({ state: 'working' }), seen, 1000);
    const r = settleStates(snap({ state: 'waiting' }), seen, 2000);
    expect(stateOf(r.snapshot)).toBe('working');
    expect(r.recheckAt).toBe(1000 + WAITING_HOLD_MS);
  });

  it('shows waiting once the hold has passed', () => {
    const seen = new Map();
    settleStates(snap({ state: 'working' }), seen, 1000);
    const r = settleStates(snap({ state: 'waiting' }), seen, 1000 + WAITING_HOLD_MS);
    expect(stateOf(r.snapshot)).toBe('waiting');
    expect(r.recheckAt).toBeUndefined();
  });

  it('shows waiting at once when the session asks the user something', () => {
    for (const ask of [{ needsPermission: true }, { isLimitPrompt: true }, { pendingQuestion: { questions: [] } }]) {
      const seen = new Map();
      settleStates(snap({ state: 'working' }), seen, 1000);
      const r = settleStates(snap({ state: 'waiting', ...ask } as Partial<Session>), seen, 1500);
      expect(stateOf(r.snapshot)).toBe('waiting');
    }
  });

  it('keeps thinking as thinking, and returns the same snapshot when nothing is held', () => {
    const seen = new Map();
    settleStates(snap({ state: 'thinking' }), seen, 1000);
    expect(stateOf(settleStates(snap({ state: 'waiting' }), seen, 1500).snapshot)).toBe('thinking');
    const idle = snap({ sessionId: 'other', state: 'waiting' });
    expect(settleStates(idle, seen, 1500).snapshot).toBe(idle);
  });

  it('never holds a closed session', () => {
    const seen = new Map();
    settleStates(snap({ state: 'working' }), seen, 1000);
    expect(stateOf(settleStates(snap({ state: 'closed' }), seen, 1500).snapshot)).toBe('closed');
  });
});
