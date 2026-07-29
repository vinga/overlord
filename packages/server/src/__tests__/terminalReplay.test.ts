import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import xtermHeadless from '@xterm/headless';
import { feedGrid, serializeGrid, disposeGrid } from '../pty/screenGrid.js';
import { sliceBufferFromLastBsu } from '../api/wsHandler.js';

const { Terminal } = xtermHeadless;

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-pty-stream.json',
);

/** Real `claude` PTY output, captured chunk-by-chunk exactly as ptyEvents buffers it. */
function loadChunks(): Buffer[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as string[];
  return raw.map(b64 => Buffer.from(b64, 'base64'));
}

/** Render an escape stream into a fresh terminal and return the visible screen. */
async function render(data: string, cols = 200, rows = 60): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(data, resolve));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  term.dispose();
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  return lines.slice(0, last + 1).join('\n');
}

describe('terminal replay', () => {
  beforeEach(() => { disposeGrid('t'); });

  it('the captured Claude stream contains no BSU frame marker', () => {
    const all = Buffer.concat(loadChunks()).toString('utf8');
    // The whole pre-existing replay design assumed Ink emits \x1b[?2026h before
    // each repaint. It does not — this is the fact that made every reopen fall
    // through to the arbitrary-tail fallback.
    expect(all.includes('\x1b[?2026h')).toBe(false);
    // What it does emit: alt-screen entry and absolute cursor addressing.
    expect(all.includes('\x1b[?1049h')).toBe(true);
    expect(/\x1b\[\d+;\d+H/.test(all)).toBe(true);
  });

  it('sliceBufferFromLastBsu finds no frame in real output, so the old replay had nothing to anchor on', () => {
    expect(sliceBufferFromLastBsu(loadChunks())).toEqual([]);
  });

  it('replaying a mid-stream byte slice does NOT reproduce the screen (the bug)', async () => {
    const chunks = loadChunks();
    const truth = await render(Buffer.concat(chunks).toString('utf8'));

    // What the old code sent on every reopen: `buf.slice(-32)` — the tail of the
    // buffer, starting at an arbitrary chunk boundary, with the alt-screen entry
    // and every earlier paint already gone.
    expect(chunks.length).toBeGreaterThan(32); // fixture must actually exercise the cut
    const tail = Buffer.concat(chunks.slice(chunks.length - 32)).toString('utf8');
    const replayed = await render(tail);

    expect(truth.length).toBeGreaterThan(0);
    expect(replayed).not.toBe(truth);
  });

  it('replaying the serialized screen grid reproduces the screen exactly (the fix)', async () => {
    const chunks = loadChunks();
    const stream = Buffer.concat(chunks).toString('utf8');
    const truth = await render(stream);

    // Feed the grid the way ptyEvents does — chunk by chunk, in order.
    for (const c of chunks) feedGrid('t', c.toString('utf8'));
    const screen = await serializeGrid('t');
    expect(screen).toBeTruthy();

    // Prefixed with a full reset, exactly as terminal:replay sends it.
    const replayed = await render(`\x1bc${screen!}`);
    expect(replayed).toBe(truth);
  });

  it('serializeGrid returns null for a session with no grid', async () => {
    expect(await serializeGrid('never-written')).toBeNull();
  });
});
