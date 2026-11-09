// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpawnDialog } from '../SpawnDialog';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ current: '/project', dirs: [], parent: null }) })));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('creation from the header menu', () => {
  it.each(['note', 'raw'] as const)('creates a %s in the chosen directory', async kind => {
    const onSpawn = vi.fn();
    await act(async () => root.render(<SpawnDialog open kind={kind} defaultPath="/project"
      suggestedName="My item" onClose={vi.fn()} onSpawn={onSpawn} />));
    expect(document.body.textContent).not.toContain('Provider');
    expect(document.body.textContent).not.toContain('Spawns a PTY session');
    const create = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Create');
    expect(create?.disabled).toBe(false);
    act(() => create!.click());
    expect(onSpawn).toHaveBeenCalledWith('/project', 'My item', kind, 'claude', '');
  });
});
