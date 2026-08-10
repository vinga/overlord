import { structuredPatch } from 'diff';

/**
 * Turns an Edit/Write tool call into a diff positioned inside the real file.
 *
 * The transcript stores only the two strings that were swapped, never a file
 * snapshot. The file on disk is the "after"; the "before" is reconstructed by
 * putting `oldString` back where `newString` now sits. That only holds while
 * `newString` still appears exactly once — every other case degrades to a
 * snippet-only diff with a stated reason, because a diff that is silently
 * anchored to the wrong place is worse than one that admits it doesn't know.
 */

export type ContextReason =
  | 'ok'
  | 'no-path'
  | 'truncated'
  | 'not-found'
  | 'ambiguous'
  | 'unavailable'
  | 'too-large'
  | 'new-file';

export const REASON_LABEL: Record<ContextReason, string> = {
  'ok': '',
  'no-path': 'No file path on this tool call — showing the snippet only.',
  'truncated': 'Edit too large to locate in the file — showing the snippet only.',
  'not-found': 'File changed since this edit — showing the snippet only.',
  'ambiguous': 'This text appears more than once — showing the snippet only.',
  'unavailable': 'File unavailable — showing the snippet only.',
  'too-large': 'File too large for context — showing the snippet only.',
  'new-file': '',
};

export interface DiffRow {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
}

export interface EditContext {
  reason: ContextReason;
  hunks: DiffHunk[];
  /** Present only when reason === 'ok' — powers context expansion without refetching. */
  fileLines?: string[];
}

export const MAX_CONTEXT_BYTES = 2_000_000;
export const MAX_CONTEXT_LINES = 20_000;
export const DEFAULT_CONTEXT = 3;

/** jsdiff hunk lines carry a leading +/-/space marker; split it off and number the rows. */
function toRows(lines: string[], oldStart: number, newStart: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  for (const line of lines) {
    const marker = line[0];
    const text = line.slice(1);
    // A "\ No newline at end of file" marker describes the previous row.
    if (marker === '\\') continue;
    if (marker === '-') rows.push({ type: 'del', text, oldLine: oldLine++ });
    else if (marker === '+') rows.push({ type: 'add', text, newLine: newLine++ });
    else rows.push({ type: 'ctx', text, oldLine: oldLine++, newLine: newLine++ });
  }
  return rows;
}

function diffToHunks(before: string, after: string, context: number): DiffHunk[] {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context });
  return patch.hunks.map(h => ({
    oldStart: h.oldStart,
    newStart: h.newStart,
    rows: toRows(h.lines, h.oldStart, h.newStart),
  }));
}

/** Snippet-only fallback: a real diff of the two strings, just with no file around it. */
export function snippetDiff(oldString: string, newString: string, context = DEFAULT_CONTEXT): DiffHunk[] {
  if (oldString === '') {
    // Write of a new file — every line is an addition; a diff adds nothing.
    const lines = newString.split('\n');
    return [{
      oldStart: 0,
      newStart: 1,
      rows: lines.map((text, i) => ({ type: 'add' as const, text, newLine: i + 1 })),
    }];
  }
  return diffToHunks(oldString, newString, context);
}

export interface BuildInput {
  oldString: string;
  newString: string;
  oldStringTruncated?: boolean;
  newStringTruncated?: boolean;
  fileText: string | null;
  context?: number;
}

/**
 * Pure core — no fetching, so the fallback ladder is directly testable.
 * `fileText: null` means the file could not be read.
 */
export function buildEditContext(input: BuildInput): EditContext {
  const { oldString, newString, fileText } = input;
  const context = input.context ?? DEFAULT_CONTEXT;

  if (oldString === '') {
    return { reason: 'new-file', hunks: snippetDiff(oldString, newString, context) };
  }

  const fallback = (reason: ContextReason): EditContext => ({
    reason,
    hunks: snippetDiff(oldString, newString, context),
  });

  // Checked before any scan: a truncated needle cannot match, and reporting
  // "file changed" for it would be a lie.
  if (input.oldStringTruncated || input.newStringTruncated) return fallback('truncated');
  if (fileText === null) return fallback('unavailable');
  if (fileText.length > MAX_CONTEXT_BYTES) return fallback('too-large');

  const first = fileText.indexOf(newString);
  if (first < 0) return fallback('not-found');
  if (fileText.indexOf(newString, first + 1) >= 0) return fallback('ambiguous');

  const fileLines = fileText.split('\n');
  if (fileLines.length > MAX_CONTEXT_LINES) return fallback('too-large');

  const before = fileText.slice(0, first) + oldString + fileText.slice(first + newString.length);
  return { reason: 'ok', hunks: diffToHunks(before, fileText, context), fileLines };
}

/**
 * Context rows immediately above a hunk, for the "expand" affordance.
 * Line numbers are 1-based and absolute in the current file.
 */
export function expandBefore(fileLines: string[], hunk: DiffHunk, count: number): DiffRow[] {
  const firstNew = hunk.rows.find(r => r.newLine !== undefined)?.newLine ?? hunk.newStart;
  const start = Math.max(1, firstNew - count);
  const rows: DiffRow[] = [];
  for (let n = start; n < firstNew; n++) {
    rows.push({ type: 'ctx', text: fileLines[n - 1] ?? '', newLine: n, oldLine: n });
  }
  return rows;
}

/** Context rows immediately below a hunk. */
export function expandAfter(fileLines: string[], hunk: DiffHunk, count: number): DiffRow[] {
  let lastNew = hunk.newStart;
  for (const r of hunk.rows) if (r.newLine !== undefined) lastNew = r.newLine;
  const end = Math.min(fileLines.length, lastNew + count);
  const rows: DiffRow[] = [];
  for (let n = lastNew + 1; n <= end; n++) {
    rows.push({ type: 'ctx', text: fileLines[n - 1] ?? '', newLine: n, oldLine: n });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// File fetching — small LRU so re-expanding a diff in the activity feed (which
// re-renders on every WebSocket tick) does not re-hit the server.
// ---------------------------------------------------------------------------

const CACHE_MAX = 30;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { text: string | null; at: number }>();

export function clearFileCache(): void {
  cache.clear();
}

export async function fetchFileText(path: string): Promise<string | null> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    // Refresh recency for the LRU eviction below.
    cache.delete(path);
    cache.set(path, hit);
    return hit.text;
  }
  let text: string | null = null;
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const body = await res.json() as { content?: string };
      text = typeof body.content === 'string' ? body.content : null;
    } else {
      // 403 here means the server's path guard refused the file — worth seeing
      // in the console, since the UI only shows "file unavailable".
      if (res.status === 403) console.warn(`[diff] file context denied by server guard: ${path}`);
      text = null;
    }
  } catch {
    text = null;
  }
  cache.set(path, { text, at: now });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return text;
}
