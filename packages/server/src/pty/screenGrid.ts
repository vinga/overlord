// @xterm/headless ships a minified CJS bundle whose named exports Node's ESM
// loader can't statically detect (cjs-module-lexer fails on the webpack IIFE),
// so `import { Terminal }` throws at runtime. Default-import the module object
// and destructure instead.
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

// Per-PTY headless terminal emulator. Reconstructs the *rendered* screen from the
// raw output stream so callers (permissionChecker, /screen) read clean, co-present
// lines instead of carriage-return/cursor-move fragments.
//
// PERFORMANCE: headless == no renderer, no DOM, no GPU. write() only mutates an
// in-memory grid (xterm's hot path, built for MB/s streams). The expensive part is
// readText() serialization, which callers run on the 3s permission cycle — never per
// chunk. Scrollback is capped to bound per-session memory; grids are disposed on PTY
// exit. So this adds a bounded VT-parse cost per output chunk and nothing else.

const COLS = 200;
const ROWS = 60;
const SCROLLBACK = 200;        // bound memory: ~ (ROWS+SCROLLBACK) lines per session
const READ_TAIL_LINES = 120;   // only serialize the bottom slice — the live screen region

class ScreenGrid {
  readonly term: Terminal;
  constructor() {
    this.term = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
  }

  write(data: string): void {
    this.term.write(data);
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
