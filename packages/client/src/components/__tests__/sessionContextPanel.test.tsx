// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContextPanel } from '../SessionContextPanel';
import type { Room, Session } from '../../types';

const room: Room = { id: 'project', name: 'Project', cwd: '/project', sessions: [] };
const session = {
  sessionId: 's1', overlordId: 'ovr-1', proposedName: 'Worker', cwd: '/project',
  jiraKeys: ['ABC-12'], prRefs: ['org/repo#34'],
  pins: [{ id: 'p1', kind: 'link', title: 'Design', url: 'https://example.com/design', createdAt: 0 }],
  latestPlan: { artifactId: 'a1', title: 'Implementation', status: 'active', updatedAt: '2026-11-09T10:00:00Z' },
} as Session;
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

describe('workspace context', () => {
  it('shows the selected session ticket, PR, plan card and pins; the plan body opens in a dialog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ artifact: { body: '# Steps\nBuild the feature. <script>bad()</script>' } }) })));
    await act(async () => root.render(<SessionContextPanel session={session} room={room} jiraBaseUrl="https://jira.example.com" />));
    expect(container.querySelector('a[href="https://jira.example.com/browse/ABC-12"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://github.com/org/repo/pull/34"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://example.com/design"]')).not.toBeNull();
    // The card shows the title only; the body lives in the dialog.
    expect(container.textContent).not.toContain('Build the feature.');
    act(() => { container.querySelector<HTMLButtonElement>('button[title="Open plan"]')!.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Build the feature.');
    expect(dialog.querySelector('script')).toBeNull();
  });

  it('reserves an empty space for a selected room and clears the session context', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ artifact: { body: 'Old plan' } }) })));
    await act(async () => root.render(<SessionContextPanel session={session} room={room} />));
    act(() => root.render(<SessionContextPanel session={null} room={room} />));
    const reserved = container.querySelector('[aria-label="Reserved context for room Project"]');
    expect(reserved).not.toBeNull();
    expect(reserved?.textContent).toBe('');
    expect(container.textContent).not.toContain('Old plan');
    expect(container.querySelector('[aria-label="Ticket"]')).toBeNull();
  });
});
