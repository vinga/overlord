// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUPS_COLLAPSED_EVENT, groupKey, groupNames, readCollapsedGroups, renameGroup, writeCollapsedGroups } from '../sessionGroups';

const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}')));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const sessions = [
  { sessionId: 'a', group: 'OV' },
  { sessionId: 'b' },
  { sessionId: 'c', group: 'PS' },
  { sessionId: 'd', group: 'OV' },
];

describe('groupNames', () => {
  it('lists each group once, in order of its first session', () => {
    expect(groupNames(sessions)).toEqual(['OV', 'PS']);
  });
});

describe('renameGroup', () => {
  it('moves every session of the group and keeps it folded under the new name', () => {
    writeCollapsedGroups(new Set([groupKey('r', 'OV')]));
    const onEvent = vi.fn();
    window.addEventListener(GROUPS_COLLAPSED_EVENT, onEvent);

    expect(renameGroup('r', sessions, 'OV', '  Overlord ')).toBe(true);

    const bodies = fetchMock.mock.calls.map(c => [String(c[0]), JSON.parse(String(c[1]?.body))]);
    expect(bodies).toEqual([
      ['/api/sessions/a/group', { group: 'Overlord' }],
      ['/api/sessions/d/group', { group: 'Overlord' }],
    ]);
    expect([...readCollapsedGroups()]).toEqual([groupKey('r', 'Overlord')]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener(GROUPS_COLLAPSED_EVENT, onEvent);
  });

  it('does nothing for an empty or unchanged name', () => {
    expect(renameGroup('r', sessions, 'OV', '   ')).toBe(false);
    expect(renameGroup('r', sessions, 'OV', 'OV')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
