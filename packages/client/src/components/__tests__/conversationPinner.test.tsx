// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationPinner } from '../ConversationPinner';
import { SelectionMenu } from '../SelectionMenu';
import { pinToSession } from '../ConversationPinner';
import { PinChip } from '../PinBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: give ranges a box so the button can be placed.
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 10, right: 40, bottom: 30, x: 10, y: 20, toJSON: () => ({}) });
}

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountFeed() {
  const ref = createRef<HTMLDivElement>();
  act(() => root.render(
    <>
      <div ref={ref}>
        <p id="msg">Pin this sentence please</p>
        <a id="lnk" href="https://hypatos.atlassian.net/browse/ABC-1">ABC-1</a>
      </div>
      <p id="outside">Text outside the feed</p>
      <ConversationPinner containerRef={ref} overlordId="ovr-1" />
      <SelectionMenu containerRef={ref} onExplain={() => {}} onPin={(text) => pinToSession('ovr-1', { text })} />
    </>,
  ));
}

function select(id: string) {
  const node = document.getElementById(id)!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 8);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

async function mouseUp() {
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r => setTimeout(r, 0));
  });
}

const pinButton = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Pin"]');

describe('pinning from the conversation', () => {
  it('pins selected text from the feed to the session', async () => {
    mountFeed();
    select('msg');
    await mouseUp();
    expect(pinButton()?.getAttribute('aria-label')).toBe('Pin selected text');
    await act(async () => { pinButton()!.click(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/pins', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ overlordId: 'ovr-1', kind: 'text', text: 'Pin this' });
  });

  it('ignores a selection outside the feed', async () => {
    mountFeed();
    select('outside');
    await mouseUp();
    expect(pinButton()).toBeNull();
  });

  it('pins a hovered link by its URL', async () => {
    mountFeed();
    act(() => { document.getElementById('lnk')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(pinButton()?.getAttribute('aria-label')).toBe('Pin link');
    await act(async () => { pinButton()!.click(); });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ overlordId: 'ovr-1', url: 'https://hypatos.atlassian.net/browse/ABC-1' });
  });
});

describe('PinChip text pin', () => {
  it('renders the text as a quote card with unpin', () => {
    const onRemove = vi.fn();
    act(() => root.render(
      <PinChip href="" kind="text" text={'Line one\nline two'} label="Line one" multiline onRemove={onRemove} removeLabel="Unpin Line one" />,
    ));
    expect(host.textContent).toContain('Line one\nline two');
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Unpin Line one"]')!.click(); });
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('PinChip text pin links', () => {
  it('turns URLs in the text into links that open in a new tab', () => {
    act(() => root.render(
      <PinChip href="" kind="text" text="See https://github.com/o/r/pull/7, then ship." label="See" multiline onRemove={() => {}} removeLabel="Unpin" />,
    ));
    const a = host.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://github.com/o/r/pull/7');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(host.textContent).toContain(', then ship.');
  });
});
