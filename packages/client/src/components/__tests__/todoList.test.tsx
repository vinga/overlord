// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodoList } from '../TodoList';
import type { Pin } from '../../types';

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

const pin = (id: string, text: string, extra: Partial<Pin> = {}): Pin =>
  ({ id, url: '', title: text, kind: 'todo', text, createdAt: 1, ...extra });

describe('TodoList', () => {
  it('lists open items first, checked ones last, with a done/total count; skips other pins', () => {
    const pins: Pin[] = [
      pin('a', 'Done by agent', { done: true, doneBy: 'agent' }),
      { id: 'l', url: 'https://a.b', title: 'link', kind: 'link', createdAt: 1 },
      pin('b', 'Open one'),
    ];
    act(() => root.render(<TodoList pins={pins} overlordId="ovr-1" />));
    const items = [...container.querySelectorAll('[data-todo]')].map(e => e.getAttribute('data-todo'));
    expect(items).toEqual(['b', 'a']);
    expect(container.querySelector('h3')!.textContent).toBe('TODO1/2');
    expect(container.textContent).toContain('agent');
    expect(container.textContent).not.toContain('link');
  });

  it('a tick sends PATCH done=true by the user and moves the item down at once', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(<TodoList pins={[pin('a', 'First'), pin('b', 'Second')]} overlordId="ovr-1" />));
    act(() => container.querySelector<HTMLInputElement>('[data-todo="a"] input')!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/pins/a', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ overlordId: 'ovr-1', done: true, by: 'user' }),
    }));
    expect([...container.querySelectorAll('[data-todo]')].map(e => e.getAttribute('data-todo'))).toEqual(['b', 'a']);
  });

  it('Enter in the input adds a TODO to the room', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(<TodoList pins={[]} cwd="/repo" />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add TODO"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setValue.call(input, 'Release'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetchMock).toHaveBeenCalledWith('/api/pins', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ cwd: '/repo', kind: 'todo', url: '', text: 'Release', owner: 'user' }),
    }));
  });

  it('owner tabs filter the list with counts; the Agent tab adds agent items', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(<TodoList pins={[pin('a', 'Mine'), pin('b', 'Bot job', { owner: 'agent' })]} overlordId="ovr-1" />));
    const tabs = () => [...container.querySelectorAll('[role="tab"]')].map(e => e.textContent);
    expect(tabs()).toEqual(['All2', 'User1', 'Agent1']);
    const ids = () => [...container.querySelectorAll('[data-todo]')].map(e => e.getAttribute('data-todo'));
    act(() => container.querySelector<HTMLButtonElement>('[data-tab="agent"]')!.click());
    expect(ids()).toEqual(['b']);
    act(() => container.querySelector<HTMLButtonElement>('[data-tab="user"]')!.click());
    expect(ids()).toEqual(['a']);

    act(() => container.querySelector<HTMLButtonElement>('[data-tab="agent"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add TODO"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setValue.call(input, 'Rerun CI'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetchMock).toHaveBeenCalledWith('/api/pins', expect.objectContaining({
      body: JSON.stringify({ overlordId: 'ovr-1', kind: 'todo', url: '', text: 'Rerun CI', owner: 'agent' }),
    }));
  });

  it('the owner icon hands an item over with PATCH owner', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(<TodoList pins={[pin('a', 'Mine')]} overlordId="ovr-1" />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Give Mine to the agent"]')!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/pins/a', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ overlordId: 'ovr-1', owner: 'agent' }),
    }));
    expect(container.querySelector('[data-todo="a"]')!.getAttribute('data-owner')).toBe('agent');
  });
});
