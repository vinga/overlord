// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentVoiceToggle } from '../AgentVoiceToggle';

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

describe('AgentVoiceToggle', () => {
  it('a click mutes with PATCH /api/settings and flips at once', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    act(() => root.render(<AgentVoiceToggle muted={false} />));
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    act(() => btn.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ agentSpeechMuted: true }),
    }));
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('follows the snapshot value', () => {
    act(() => root.render(<AgentVoiceToggle muted />));
    expect(container.querySelector('button')!.hasAttribute('data-muted')).toBe(true);
  });
});
