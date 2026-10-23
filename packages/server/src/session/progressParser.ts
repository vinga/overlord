import type { ProgressRow } from '../types.js';

/**
 * Progress markers printed by background commands (see bin/ovr-watch):
 *
 *   ::progress id=dev label="Dev deploy" step=3/25 state=behind:: running=52b958d
 *
 * Every attribute is optional; `id` defaults to `main`. A bare `done`, `fail`
 * or `stopped` flag marks the row final. Any other output line is plain text.
 */
const MARKER_RE = /^::progress(?:\s+(.*?))?\s*::\s?(.*)$/;
const ATTR_RE = /([A-Za-z][\w-]*)(?:=("(?:[^"\\]|\\.)*"|\S+))?/g;
// CSI / OSC escape sequences — a TTY-mode script redraws with these.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const MAX_MESSAGE_LENGTH = 300;

/** Strip escapes and keep only what a terminal would show after `\r` redraws. */
export function cleanOutputLine(raw: string): string {
  const noAnsi = raw.replace(ANSI_RE, '');
  const lastSegment = noAnsi.split('\r').filter(s => s.trim().length > 0).pop() ?? '';
  return lastSegment.trim().slice(0, MAX_MESSAGE_LENGTH);
}

export function parseProgressLine(line: string, at: number): ProgressRow | null {
  const m = MARKER_RE.exec(line);
  if (!m) return null;
  const row: ProgressRow = { id: 'main', message: m[2].trim().slice(0, MAX_MESSAGE_LENGTH), at };
  for (const a of (m[1] ?? '').matchAll(ATTR_RE)) {
    const key = a[1];
    const rawVal = a[2];
    const val = rawVal?.startsWith('"') ? rawVal.slice(1, -1).replace(/\\(.)/g, '$1') : rawVal;
    if (val === undefined) {
      if (key === 'done' || key === 'fail' || key === 'stopped') row.final = key;
      continue;
    }
    switch (key) {
      case 'id': if (/^[\w.-]+$/.test(val)) row.id = val; break;
      case 'label': row.label = val.slice(0, 120); break;
      case 'state': row.state = val.slice(0, 40); break;
      case 'step': {
        const s = /^(\d+)(?:\/(\d+))?$/.exec(val);
        if (s) {
          row.step = Number(s[1]);
          if (s[2] !== undefined) row.max = Number(s[2]);
        }
        break;
      }
      case 'pct': {
        const n = Number(val);
        if (Number.isFinite(n)) row.pct = Math.max(0, Math.min(100, n));
        break;
      }
    }
  }
  return row;
}

/** Upsert a row by id, keeping first-seen order. A label given once sticks. */
export function mergeRow(rows: ProgressRow[], row: ProgressRow): ProgressRow[] {
  const i = rows.findIndex(r => r.id === row.id);
  if (i === -1) return [...rows, row];
  const merged = { ...row, label: row.label ?? rows[i].label };
  return rows.map((r, j) => (j === i ? merged : r));
}
