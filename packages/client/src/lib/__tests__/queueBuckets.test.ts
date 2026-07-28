import { describe, expect, it } from 'vitest';
import type { Room, Session } from '../../types';
import { buildQueue, classifySession, formatAge, formatElapsed } from '../queueBuckets';

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'sid-1',
    pid: 1,
    startedAt: 0,
    cwd: '/repo',
    state: 'waiting',
    lastActivity: '2026-07-27T10:00:00.000Z',
    color: 'hsl(30, 75%, 55%)',
    subagents: [],
    ...over,
  };
}

function room(sessions: Session[], name = 'repo'): Room {
  return { id: 'r1', name, cwd: '/repo', sessions };
}

describe('classifySession', () => {
  it('puts a permission prompt in approval', () => {
    expect(classifySession(session({ needsPermission: true }))).toBe('approval');
  });

  it('puts a pending AskUserQuestion in question', () => {
    const s = session({ pendingQuestion: { questions: [{ question: 'Which?', options: [] }] } });
    expect(classifySession(s)).toBe('question');
  });

  it('ignores an empty pendingQuestion set', () => {
    expect(classifySession(session({ pendingQuestion: { questions: [] } }))).toBe('idle');
  });

  it('puts a pending plan in plan', () => {
    const s = session({ latestPlan: { artifactId: 'a1', title: 'T', status: 'pending', updatedAt: '' } });
    expect(classifySession(s)).toBe('plan');
  });

  it('does not queue a plan that is already active', () => {
    const s = session({ latestPlan: { artifactId: 'a1', title: 'T', status: 'active', updatedAt: '' } });
    expect(classifySession(s)).toBe('idle');
  });

  it('puts an unknown command and a dead bridge in error', () => {
    expect(classifySession(session({ unknownCommand: '/nope' }))).toBe('error');
    expect(classifySession(session({ bridgeDead: true }))).toBe('error');
  });

  it('puts a scheduled wakeup in sleeping', () => {
    expect(classifySession(session({ scheduledWakeupAt: 1 }))).toBe('sleeping');
  });

  it('puts a pending background command in sleeping', () => {
    const s = session({ backgroundTasks: [{ toolUseId: 'tu-1', taskId: 'bw5', startedAt: '2026-07-27T10:00:00.000Z' }] });
    expect(classifySession(s)).toBe('sleeping');
  });

  it('ignores an empty backgroundTasks array', () => {
    expect(classifySession(session({ backgroundTasks: [] }))).toBe('idle');
  });

  it('ranks a scheduled wakeup above a pending background command', () => {
    const s = session({
      scheduledWakeupAt: 1,
      backgroundTasks: [{ toolUseId: 'tu-1', taskId: 'bw5' }],
    });
    expect(classifySession(s)).toBe('sleeping');
  });

  it('ranks approval above sleeping', () => {
    const s = session({ needsPermission: true, scheduledWakeupAt: 1 });
    expect(classifySession(s)).toBe('approval');
  });

  // Review/done was removed — an agent that says it finished is just waiting.
  it('treats a plainly-stopped agent as idle, with no finished bucket', () => {
    expect(classifySession(session({ lastMessage: "I've completed the task." }))).toBe('idle');
  });

  it('keeps a read waiting session in idle', () => {
    expect(classifySession(session({ review: 'read' }))).toBe('idle');
  });

  it('moves a parked session to the parked bucket', () => {
    expect(classifySession(session({ review: 'parked' }))).toBe('parked');
  });

  // Park is sticky: it must outrank both the blocking buckets and the
  // "running sessions produce no row" rule.
  it('keeps a parked session parked even when it needs approval', () => {
    expect(classifySession(session({ review: 'parked', needsPermission: true }))).toBe('parked');
  });

  it('keeps a parked session parked even while it is working', () => {
    expect(classifySession(session({ review: 'parked', state: 'working' }))).toBe('parked');
  });

  it('still drops a parked session once it is archived', () => {
    expect(classifySession(session({ review: 'parked', isArchived: true }))).toBeNull();
  });

  it('produces no row for running or closed sessions', () => {
    expect(classifySession(session({ state: 'working' }))).toBeNull();
    expect(classifySession(session({ state: 'thinking' }))).toBeNull();
    expect(classifySession(session({ state: 'closed' }))).toBeNull();
  });

  it('produces no row for archived sessions', () => {
    expect(classifySession(session({ isArchived: true }))).toBeNull();
  });
});

describe('buildQueue', () => {
  const older = session({ sessionId: 'old', overlordId: 'ovr-old', needsPermission: true, lastActivity: '2026-07-27T09:00:00.000Z' });
  const newer = session({ sessionId: 'new', overlordId: 'ovr-new', needsPermission: true, lastActivity: '2026-07-27T10:00:00.000Z' });

  it('sorts oldest first by default', () => {
    const q = buildQueue([room([newer, older])], {});
    expect(q.groups[0].items.map(i => i.key)).toEqual(['ovr-old', 'ovr-new']);
  });

  it('reverses on newest-first', () => {
    const q = buildQueue([room([older, newer])], {}, 'newest');
    expect(q.groups[0].items.map(i => i.key)).toEqual(['ovr-new', 'ovr-old']);
  });

  it('counts only actionable buckets toward the badge', () => {
    const q = buildQueue([room([
      session({ sessionId: 'a', needsPermission: true }),
      session({ sessionId: 'b' }),                        // idle
      session({ sessionId: 'c', scheduledWakeupAt: 1 }),  // sleeping
    ])], {});
    expect(q.badgeCount).toBe(1);
    expect(q.groups.map(g => g.meta.id)).toEqual(['approval', 'sleeping', 'idle']);
  });

  it('tallies running sessions instead of listing them', () => {
    const q = buildQueue([room([
      session({ sessionId: 'a', state: 'working' }),
      session({ sessionId: 'b', state: 'thinking' }),
    ])], {});
    expect(q.workingCount).toBe(2);
    expect(q.groups).toHaveLength(0);
  });

  it('excludes sleeping from flat mode', () => {
    const q = buildQueue([room([
      session({ sessionId: 'a', needsPermission: true }),
      session({ sessionId: 'c', scheduledWakeupAt: 1 }),
    ])], {});
    expect(q.flat.map(i => i.bucket)).toEqual(['approval']);
  });

  it('orders flat purely by time, across buckets', () => {
    const q = buildQueue([room([
      session({ sessionId: 'a', overlordId: 'ovr-a', needsPermission: true, lastActivity: '2026-07-27T10:00:00.000Z' }),
      session({ sessionId: 'b', overlordId: 'ovr-b', lastActivity: '2026-07-27T09:00:00.000Z' }),
    ])], {});
    expect(q.flat.map(i => i.key)).toEqual(['ovr-b', 'ovr-a']);
  });

  it('resolves names through customNames and carries the room name', () => {
    const q = buildQueue([room([session({ sessionId: 'sid-1', proposedName: 'Vex' })], 'overlord')], { 'sid-1': 'Renamed' });
    expect(q.groups[0].items[0].name).toBe('Renamed');
    expect(q.groups[0].items[0].roomName).toBe('overlord');
  });

  it('keeps parked rows out of the badge and out of flat mode', () => {
    const q = buildQueue([room([
      session({ sessionId: 'a', needsPermission: true }),
      session({ sessionId: 'b', overlordId: 'ovr-b', review: 'parked', needsPermission: true }),
    ])], {});
    expect(q.badgeCount).toBe(1);
    expect(q.flat.map(i => i.bucket)).toEqual(['approval']);
    expect(q.groups.map(g => g.meta.id)).toEqual(['approval', 'parked']);
  });

  it('does not count a parked working session as running', () => {
    const q = buildQueue([room([session({ review: 'parked', state: 'working' })])], {});
    expect(q.workingCount).toBe(0);
    expect(q.groups.map(g => g.meta.id)).toEqual(['parked']);
  });

  it('shows the park reason as row detail, and the live bucket as its chip', () => {
    const q = buildQueue([room([
      session({ review: 'parked', parkReason: '  waiting on  BACKEND-1234 ', needsPermission: true }),
    ])], {});
    const item = q.groups[0].items[0];
    expect(item.detail).toBe('waiting on BACKEND-1234');
    expect(item.liveBucket).toBe('approval');
  });

  it('falls back to the last message when a park has no reason', () => {
    const q = buildQueue([room([session({ review: 'parked', lastMessage: 'Done for now.' })])], {});
    expect(q.groups[0].items[0].detail).toBe('Done for now.');
    expect(q.groups[0].items[0].liveBucket).toBeUndefined();
  });

  it('surfaces the blocking prompt as row detail', () => {
    const q = buildQueue([room([session({ needsPermission: true, permissionPromptText: '  rm   -rf  bridge/ ' })])], {});
    expect(q.groups[0].items[0].detail).toBe('rm -rf bridge/');
  });

  it('tolerates an unparseable lastActivity', () => {
    const q = buildQueue([room([session({ lastActivity: 'not-a-date' })])], {});
    expect(q.groups[0].items[0].activityAt).toBe(0);
  });
});

describe('formatElapsed', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  it('renders seconds, minutes, hours', () => {
    expect(formatElapsed('2026-07-27T11:59:30.000Z', now)).toBe('30s');
    expect(formatElapsed('2026-07-27T11:55:00.000Z', now)).toBe('5m');
    expect(formatElapsed('2026-07-27T09:00:00.000Z', now)).toBe('3h');
    expect(formatElapsed('2026-07-27T08:30:00.000Z', now)).toBe('3h 30m');
  });
  it('renders nothing for a missing or unparseable timestamp', () => {
    expect(formatElapsed(undefined, now)).toBe('');
    expect(formatElapsed('not-a-date', now)).toBe('');
  });
  it('clamps a future start to 0s rather than going negative', () => {
    expect(formatElapsed('2026-07-27T12:00:30.000Z', now)).toBe('0s');
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  it('collapses sub-minute to now', () => {
    expect(formatAge(now - 30_000, now)).toBe('now');
  });
  it('renders minutes, hours, days', () => {
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatAge(now - 50 * 3_600_000, now)).toBe('2d');
  });
  it('renders nothing for a missing timestamp', () => {
    expect(formatAge(0, now)).toBe('');
  });
});
