import { describe, expect, it } from 'vitest';
import type { Room, Session } from '../../types';
import { mergeSources, metadataSources } from '../searchSources';

const session = (over: Partial<Session> = {}) => ({ sessionId: 's1', ...over }) as Session;
const room = (over: Partial<Room> = {}) => ({ id: 'r', name: 'r', cwd: '/r', sessions: [], ...over }) as unknown as Room;

describe('metadataSources', () => {
  it('ticket: key, title, type or status', () => {
    const s = session({ jiraKeys: ['BACKEND-1'] });
    expect(metadataSources(s, null, 'backend-1', {})).toEqual(['ticket']);
    expect(metadataSources(s, null, 'flaky', { jiraMeta: { 'BACKEND-1': { title: 'Flaky test' } } })).toEqual(['ticket']);
    expect(metadataSources(s, null, 'nothing', {})).toEqual([]);
  });

  it('pr, pin (session or room), notes, subagent', () => {
    const s = session({
      prRefs: ['hypatos/overlord#42'],
      pins: [{ id: 'p', url: 'https://x.dev/doc', title: 'Design doc', kind: 'link', createdAt: 0 }],
      subagents: [{ agentType: 'Explore', description: 'find callers' }] as Session['subagents'],
    });
    expect(metadataSources(s, null, '#42', {})).toEqual(['pr']);
    expect(metadataSources(s, null, 'design', {})).toEqual(['pin']);
    const r = room({ pins: [{ id: 'q', url: 'https://wiki/room', title: 'Room wiki', kind: 'link', createdAt: 0 }] });
    expect(metadataSources(session(), r, 'wiki', {})).toEqual(['pin']);
    expect(metadataSources(s, null, 'second line', { noteText: () => 'first\nsecond line' })).toEqual(['notes']);
    expect(metadataSources(s, null, 'callers', {})).toEqual(['subagent']);
  });
});

describe('mergeSources', () => {
  it('de-duplicates and keeps display order', () => {
    expect(mergeSources(['tool', 'you'], ['ticket', 'you'])).toEqual(['you', 'tool', 'ticket']);
  });
});
