// @xterm/headless ships a minified CJS bundle whose named exports Node's ESM
// loader can't statically detect (cjs-module-lexer fails on the webpack IIFE),
// so `import { Terminal }` throws at runtime. Default-import the module object
// and destructure instead.
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;
type Terminal = InstanceType<typeof Terminal>;

// Per-PTY headless terminal emulator. Reconstructs the *rendered* screen from the
// raw output stream so callers (permissionChecker, /screen) read clean, co-present
// lines instead of carriage-return/cursor-move fragments.
//
// It is also the ONLY correct source for terminal replay. The Claude TUI emits
// cursor-addressed incremental updates with no frame markers (verified: zero
// `\x1b[?2026h` in a captured stream — see __tests__/fixtures/claude-pty-stream.json),
// so replaying raw buffered bytes into a fresh xterm applies deltas against a screen
// state that doesn't exist. The grid holds the resolved screen; serializeGrid() turns
// it back into a self-contained escape stream any fresh terminal can render.
//
// PERFORMANCE: headless == no renderer, no DOM, no GPU. write() only mutates an
// in-memory grid (xterm's hot path, built for MB/s streams). The expensive parts are
// readText() (3s permission cycle) and serializeGrid() (terminal reopen only) — never
// per chunk. Scrollback is capped to bound per-session memory; grids are disposed on
// PTY exit. So this adds a bounded VT-parse cost per output chunk and nothing else.

const COLS = 200;
const ROWS = 60;
const SCROLLBACK = 200;        // bound memory: ~ (ROWS+SCROLLBACK) lines per session
const READ_TAIL_LINES = 120;   // only serialize the bottom slice — the live screen region
const REPLAY_SCROLLBACK = 200; // lines of history included in a reopen repaint

class ScreenGrid {
  readonly term: Terminal;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  constructor() {
    this.term = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  write(data: string): void {
    this.term.write(data);
  }

  /** xterm parses writes on its own async queue, so data written moments ago may
   *  not be in the buffer yet. Awaiting an empty write resolves after everything
   *  queued before it has been parsed. */
  flush(): Promise<void> {
    return new Promise<void>(resolve => this.term.write('', resolve));
  }

  /** The rendered screen as a self-contained escape stream: styling, cursor
   *  position and scrollback, with no dependency on prior terminal state. */
  serialize(): string {
    return this.serializer.serialize({ scrollback: REPLAY_SCROLLBACK });
  }

  // Serialize the bottom READ_TAIL_LINES of the active buffer to plain text.
  // translateToString(true) trims trailing whitespace per line; we then drop
  // trailing blank lines. Cheap relative to the buffer size and only called on
  // the permission-check cycle.
  readText(): string {
    const buf = this.term.buffer.active;
    const end = buf.length;
    const start = Math.max(0, end - READ_TAIL_LINES);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    // Drop trailing blank lines so callers see the real screen tail.
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') last--;
    return lines.slice(0, last + 1).join('\n');
  }

  dispose(): void {
    this.term.dispose();
  }
}

const grids = new Map<string, ScreenGrid>();

// Feed raw PTY output into the session's grid, creating it lazily on first chunk.
export function feedGrid(ptyId: string, data: string): void {
  let g = grids.get(ptyId);
  if (!g) { g = new ScreenGrid(); grids.set(ptyId, g); }
  g.write(data);
}

/** Serialize a session's rendered screen for terminal replay. Returns null when
 *  no grid exists (nothing has been written yet) or the screen is empty.
 *
 *  Async because xterm parses on a queue: without the flush, output that arrived
 *  in the same tick as the reopen would be missing from the replayed screen. */
export async function serializeGrid(key: string): Promise<string | null> {
  const g = grids.get(key);
  if (!g) return null;
  await g.flush();
  const out = g.serialize();
  return out.length > 0 ? out : null;
}

// Read the reconstructed screen text for a session, or null if no grid exists.
export function readGridText(key: string): string | null {
  const g = grids.get(key);
  if (!g) return null;
  const text = g.readText();
  return text.length > 0 ? text : null;
}

// Move a grid from ptyId → ovrId on PTY exit so a closed-session read still works
// briefly (mirrors ptyOutputBuffer migration). Disposes any grid already at newKey.
export function migrateGrid(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const g = grids.get(oldKey);
  if (!g) return;
  const existing = grids.get(newKey);
  if (existing) existing.dispose();
  grids.set(newKey, g);
  grids.delete(oldKey);
}

export function disposeGrid(key: string): void {
  const g = grids.get(key);
  if (!g) return;
  g.dispose();
  grids.delete(key);
}
