// See screenGrid.ts: @xterm/headless needs a default import under Node ESM.
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;
type Cell = NonNullable<ReturnType<NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>['getCell']>>;

// A restored shell log is a byte stream recorded at whatever width the PTY had
// then (often ~200 cols). zsh positions its right prompt with relative cursor
// moves (`\e[131C`) and pads PROMPT_SP with cols-1 spaces, so replaying the raw
// bytes into a narrower xterm wraps every prompt into fragments.
//
// Instead, resolve the stream in a headless terminal wide enough that nothing
// recorded at a smaller width wraps — relative moves land exactly where they
// did — then emit each rendered line as plain styled text, squeezing the gap
// before a right-aligned segment so it fits the viewer's width.
const RENDER_COLS = 320;
const RENDER_ROWS = 50;
const SCROLLBACK = 5000;
const MIN_GAP = 2;

interface StyledCell { chars: string; sgr: string; blank: boolean }

function colorSgr(isRgb: boolean, isPalette: boolean, color: number, base: number, bright: number, ext: number): string | null {
  if (isRgb) return `${ext};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
  if (!isPalette) return null;
  if (color < 8) return String(base + color);
  if (color < 16) return String(bright + color - 8);
  return `${ext};5;${color}`;
}

function cellSgr(c: Cell): string {
  const parts = ['0'];
  if (c.isBold()) parts.push('1');
  if (c.isDim()) parts.push('2');
  if (c.isItalic()) parts.push('3');
  if (c.isUnderline()) parts.push('4');
  if (c.isInverse()) parts.push('7');
  if (c.isStrikethrough()) parts.push('9');
  const fg = colorSgr(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30, 90, 38);
  if (fg) parts.push(fg);
  const bg = colorSgr(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40, 100, 48);
  if (bg) parts.push(bg);
  return `\x1b[${parts.join(';')}m`;
}

/** Shrink the widest run of plain blanks so the line fits `cols`, keeping at
 *  least MIN_GAP — a right prompt stays right-aligned at the new width. A line
 *  with no such gap is returned as is and wraps in the viewer. */
function fitLine(cells: StyledCell[], cols: number): StyledCell[] {
  const excess = cells.length - cols;
  if (excess <= 0) return cells;
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= cells.length; i++) {
    const blank = i < cells.length && cells[i].blank;
    if (blank && runStart < 0) runStart = i;
    if (!blank && runStart >= 0) {
      if (i - runStart > bestLen) { bestLen = i - runStart; bestStart = runStart; }
      runStart = -1;
    }
  }
  if (bestLen <= MIN_GAP) return cells;
  const cut = Math.min(excess, bestLen - MIN_GAP);
  return [...cells.slice(0, bestStart), ...cells.slice(bestStart + cut)];
}

export async function renderShellHistory(data: Buffer, cols: number): Promise<string> {
  const term: Terminal = new Terminal({ cols: RENDER_COLS, rows: RENDER_ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => term.write(new Uint8Array(data), resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    let cell: Cell | undefined;
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const cells: StyledCell[] = [];
      let lastContent = -1;
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        const blank = chars === ' ' && cell.isBgDefault() && !cell.isInverse();
        cells.push({ chars, sgr: cellSgr(cell), blank });
        if (!blank) lastContent = cells.length - 1;
      }
      const fitted = fitLine(cells.slice(0, lastContent + 1), cols > 0 ? cols : RENDER_COLS);
      let out = '';
      let sgr = '';
      for (const c of fitted) {
        if (c.sgr !== sgr) { out += c.sgr; sgr = c.sgr; }
        out += c.chars;
      }
      lines.push(sgr ? `${out}\x1b[0m` : out);
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\r\n');
  } finally {
    term.dispose();
  }
}
