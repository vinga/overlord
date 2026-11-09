// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitSyncStatus } from '../GitSyncStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (props: React.ComponentProps<typeof GitSyncStatus>) => {
  act(() => root.render(<GitSyncStatus {...props} />));
  return host.textContent ?? '';
};

describe('GitSyncStatus', () => {
  it('says nothing before the server has read the branch', () => {
    expect(render({})).toBe('');
  });

  it('reports up to date against the upstream', () => {
    expect(render({ gitUpstream: 'origin/main' })).toBe('up to date with origin/main');
  });

  it('lists push, pull and uncommitted counts', () => {
    expect(render({ gitUpstream: 'origin/main', gitAhead: 2, gitBehind: 3, gitDirty: 4 }))
      .toBe('↑2 to push·↓3 to pull·4 uncommitted');
  });

  it('flags a branch that tracks no remote', () => {
    expect(render({ gitUpstream: null, gitDirty: 1 })).toBe('not on remote·1 uncommitted');
  });
});
