// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinBar, copyPinToRoom, pinInRoom } from '../PinBar';
import type { Pin } from '../../types';

vi.mock('../../hooks/useJiraMeta', () => ({ useJiraMeta: () => ({}) }));

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const link: Pin = { id: 'l1', url: 'https://example.com/doc', title: 'Doc', kind: 'link', createdAt: 1 };
const text: Pin = { id: 't1', url: '', title: '', kind: 'text', text: 'remember this', createdAt: 1 };

describe('copy pin to room', () => {
  it('posts a link pin and a text pin to the room cwd', async () => {
    await copyPinToRoom(link, '/repo');
    await copyPinToRoom(text, '/repo');
    const bodies = fetchMock.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0]).toEqual({ cwd: '/repo', url: 'https://example.com/doc', kind: 'link', title: 'Doc' });
    expect(bodies[1]).toEqual({ cwd: '/repo', kind: 'text', text: 'remember this' });
  });

  it('pinInRoom matches by URL, or by text for text pins', () => {
    expect(pinInRoom(link, [{ ...link, id: 'r1' }])).toBe(true);
    expect(pinInRoom(text, [{ ...text, id: 'r2' }])).toBe(true);
    expect(pinInRoom(text, [{ ...link, id: 'r3' }])).toBe(false);
    expect(pinInRoom(link, undefined)).toBe(false);
  });

  it('session bars get the icon (lit when the room has the pin); room bars do not', async () => {
    act(() => root.render(<>
      <PinBar pins={[link, text]} overlordId="ovr-1" roomCwd="/repo" roomPins={[{ ...link, id: 'r1' }]} hideAdder multiline />
      <PinBar pins={[{ ...link, id: 'r1' }]} cwd="/repo" hideAdder />
    </>));
    const btns = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy to room"], button[aria-label="Already in this room"]')];
    expect(btns.map(b => b.getAttribute('aria-label'))).toEqual(['Already in this room', 'Copy to room']);
    act(() => btns[0].click());
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { btns[1].click(); });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ cwd: '/repo', kind: 'text', text: 'remember this' });
  });
});
