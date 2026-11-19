import * as fs from 'fs';

const CHUNK = 4 * 1024 * 1024;
const TS_RE = /"timestamp":"([^"\\]+)"/g;

/** True once a line's top-level timestamp is at or past `before`. Fast path:
 *  every `"timestamp":"…"` in the raw line is earlier → keep without parsing
 *  (escaped copies inside string values never match the pattern). Otherwise
 *  parse, so a nested later timestamp can't end the scan early. */
function reachedTimestamp(line: string, before: string): boolean {
  let max: string | undefined;
  for (const m of line.matchAll(TS_RE)) if (max === undefined || m[1] > max) max = m[1];
  if (max === undefined || max < before) return false;
  try {
    const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    return typeof ts === 'string' && ts >= before;
  } catch {
    return false;   // unparseable lines are kept, as before
  }
}

/**
 * The last `keep` non-empty transcript lines before the first line whose
 * timestamp is ≥ `before` (lines are chronological). Streams the file in
 * chunks and keeps only a ring of `keep` lines, so a transcript of any size
 * is covered — the old whole-file read stopped at 32 MB, which cut off every
 * message past that point from "load older".
 * `total` counts all lines before the cut, for "is there more" checks.
 */
export function readLinesBefore(filePath: string, before: string, keep: number): { lines: string[]; total: number } {
  const ring: string[] = [];
  let total = 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      const data = n > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : carry;
      pos += n;
      // Split on newline bytes, so a multi-byte char cut by the chunk edge
      // is decoded only once its line is whole.
      let start = 0;
      const atEof = n <= 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1 && !atEof) break;
        const end = nl === -1 ? data.length : nl;
        const line = data.subarray(start, end).toString('utf8');
        start = end + 1;
        if (line.trim()) {
          if (reachedTimestamp(line, before)) return { lines: ring, total };
          ring.push(line);
          if (ring.length > keep) ring.shift();
          total++;
        }
        if (nl === -1) break;
      }
      if (atEof) return { lines: ring, total };
      carry = data.subarray(Math.min(start, data.length));
    }
  } finally {
    fs.closeSync(fd);
  }
}
