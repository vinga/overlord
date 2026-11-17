// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomTabs } from '../RoomTabs';
import type { Room } from '../../types';

const room: Room = { id: 'project', name: 'Project', cwd: '/project', sessions: [] };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('room chip navigation', () => {
  it('keeps the last visible room reachable and hides it without opening its details', () => {
    const onHide = vi.fn();
    const onOpenRoom = vi.fn();
    act(() => root.render(<RoomTabs rooms={[room]} scrollRef={{ current: null }} onMove={vi.fn()}
      onHide={onHide} onOpenRoom={onOpenRoom} />));
    const hide = container.querySelector<HTMLButtonElement>('[aria-label="Hide room Project"]');
    expect(hide).not.toBeNull();
    act(() => hide!.click());
    expect(onHide).toHaveBeenCalledWith('project', '/project');
    expect(onOpenRoom).not.toHaveBeenCalled();
  });

  it('counts all live, closed and archived sessions even when the list is filtered', () => {
    act(() => root.render(<RoomTabs rooms={[room]} scrollRef={{ current: null }} onMove={vi.fn()}
      sessionCounts={{ project: 7 }} archiveCounts={{ project: 12 }} />));
    expect(container.querySelector('button')?.title).toContain('19 sessions total');
  });

  it('folds a room\'s session list and remembers it', () => {
    localStorage.removeItem('overlord:roomTabsCollapsed');
    const withSession = { ...room, sessions: [{ sessionId: 's1', proposedName: 'Astra', state: 'waiting', cwd: '/project', pid: 1, lastActivity: '' } as unknown as Room['sessions'][number]] };
    const onOpenRoom = vi.fn();
    act(() => root.render(<RoomTabs rooms={[withSession]} scrollRef={{ current: null }} onMove={vi.fn()}
      showSessions onOpenRoom={onOpenRoom} />));
    expect(container.textContent).toContain('Astra');
    const fold = container.querySelector<HTMLButtonElement>('[aria-label="Collapse Project"]')!;
    act(() => fold.click());
    expect(container.textContent).not.toContain('Astra');
    expect(onOpenRoom).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('overlord:roomTabsCollapsed')!)).toEqual(['project']);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand Project"]')!.click());
    expect(container.textContent).toContain('Astra');
  });
});
