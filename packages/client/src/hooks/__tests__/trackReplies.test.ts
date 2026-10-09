import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, trackReplies, type Pending, type ReplyWorker } from '../useReplySpeaker';

const worker = (over: Partial<ReplyWorker> = {}): ReplyWorker =>
  ({ ovrId: 'ovr-1', name: 'atlas', state: 'waiting', lastMessage: 'old reply', ...over });

function pendingFor(baseline: string | undefined, at = 0): Map<string, Pending> {
  return new Map([['ovr-1', { baseline, sawBusy: false, at }]]);
}

describe('trackReplies', () => {
  it('does not fire while the worker still shows the previous reply', () => {
    const pending = pendingFor('old reply');
    expect(trackReplies(pending, [worker()], 0)).toEqual([]);
    expect(pending.size).toBe(1);
  });

  it('fires once the worker went busy and came back waiting', () => {
    const pending = pendingFor('old reply');
    trackReplies(pending, [worker({ state: 'working' })], 0);
    expect(trackReplies(pending, [worker({ lastMessage: 'new reply' })], 0)).toHaveLength(1);
  });

  it('fires on a changed message even if the busy phase was never seen', () => {
    const pending = pendingFor('old reply');
    const out = trackReplies(pending, [worker({ lastMessage: 'new reply' })], 0);
    expect(out[0]).toMatchObject({ lastMessage: 'new reply' });
  });

  it('fires after a busy phase even when the reply text repeats', () => {
    const pending = pendingFor('done.');
    trackReplies(pending, [worker({ state: 'thinking', lastMessage: 'done.' })], 0);
    expect(trackReplies(pending, [worker({ lastMessage: 'done.' })], 0)).toHaveLength(1);
  });

  it('forgets a prompt whose worker closed or vanished', () => {
    const closed = pendingFor('x');
    trackReplies(closed, [worker({ state: 'closed' })], 0);
    expect(closed.size).toBe(0);
    const gone = pendingFor('x');
    trackReplies(gone, [], 0);
    expect(gone.size).toBe(0);
  });

  it('forgets a prompt that never got an answer', () => {
    const pending = pendingFor('old reply', 0);
    trackReplies(pending, [worker()], PENDING_TTL_MS + 1);
    expect(pending.size).toBe(0);
  });
});
