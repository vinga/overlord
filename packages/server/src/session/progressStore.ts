import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BackgroundTask,
  BackgroundProgress,
  BackgroundProgressStatus,
  ProgressHistoryEntry,
} from '../types.js';
import { cleanOutputLine, mergeRow, parseProgressLine } from './progressParser.js';

/**
 * Progress cards for `Bash(run_in_background)` commands, read from the command's
 * output file by the server — the agent spends no tokens on it.
 *
 * Driven by the 3s transcript poll (syncSession), never by its own timer. Reads
 * are incremental (byte offset) and gated on the output file's mtime. Every
 * line is appended to ~/.claude/overlord/progress/<sessionId>/<toolUseId>.jsonl
 * so a card survives /tmp cleanup, restarts and closed sessions.
 */

const MAX_READ_BYTES = 64 * 1024;
// Past this many persisted lines only markers are written; raw output (a dev
// server, a build log) still updates lastLine in memory.
const MAX_PERSISTED_LINES = 500;
const MAX_CARDS_PER_SESSION = 20;
// Matches BACKGROUND_TASK_TTL_MS in transcriptReader: a running card older
// than this whose task never reappeared was lost while the server was down.
const ORPHAN_TTL_MS = 6 * 60 * 60 * 1000;

interface Tracked {
  card: BackgroundProgress;
  outputFile?: string;
  offset: number;
  lastMtime: number;
  partial: string;
  persistedLines: number;
  /** Seen in the live backgroundTasks list during this process. */
  seenLive: boolean;
  /** Push cards: last gap between lines, for the staleness cutoff. */
  pushGapMs?: number;
}

/** A pushed card that just ended, for the completion ping (see takeEndedPushCards). */
export interface EndedPushCard {
  sessionId: string;
  card: BackgroundProgress;
}

// Push cards have no task notification: they end on an all-final set of rows,
// or go stale when lines stop (the watcher was killed with -9, the laptop slept).
const PUSH_STALE_MIN_MS = 120_000;
const endedPushCards: EndedPushCard[] = [];

const sessions = new Map<string, Map<string, Tracked>>();

function progressRoot(): string {
  // $HOME first so tests can stub it (os.homedir() ignores the env on macOS).
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.claude', 'overlord', 'progress');
}

function sessionDir(sessionId: string): string {
  return path.join(progressRoot(), sessionId);
}

function safeName(id: string): string {
  return id.replace(/[^\w.-]/g, '_');
}

function historyFile(sessionId: string, toolUseId: string): string {
  return path.join(sessionDir(sessionId), `${safeName(toolUseId)}.jsonl`);
}

function persist(sessionId: string, toolUseId: string, entries: ProgressHistoryEntry[]): void {
  if (entries.length === 0) return;
  try {
    fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    fs.appendFileSync(historyFile(sessionId, toolUseId), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch {
    // best-effort: the live card still renders from memory
  }
}

function readHistoryFile(file: string): ProgressHistoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: ProgressHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as ProgressHistoryEntry); } catch { /* torn line */ }
  }
  return out;
}

/** Rebuild a card from its persisted history. */
export function replayHistory(entries: ProgressHistoryEntry[], now = Date.now()): BackgroundProgress | null {
  const meta = entries.find(e => e.t === 'meta');
  if (!meta || meta.t !== 'meta') return null;
  let card: BackgroundProgress = {
    toolUseId: meta.toolUseId,
    taskId: meta.taskId,
    description: meta.description,
    command: meta.command,
    startedAt: meta.startedAt,
    status: 'running',
    rows: [],
    lineCount: 0,
    ...(meta.source === 'push' ? { source: 'push' as const } : {}),
  };
  for (const e of entries) {
    if (e.t === 'line') card = applyLine(card, e.text, e.row, e.at);
    else if (e.t === 'end') card = { ...card, status: e.status, endedAt: e.at };
  }
  const startedMs = card.startedAt ? Date.parse(card.startedAt) : NaN;
  if (card.status === 'running' && (!Number.isFinite(startedMs) || now - startedMs > ORPHAN_TTL_MS)) {
    card = { ...card, status: 'stopped', endedAt: card.lastAt };
  }
  return card;
}

function applyLine(card: BackgroundProgress, text: string, row: BackgroundProgress['rows'][number] | undefined, at: number): BackgroundProgress {
  return {
    ...card,
    rows: row ? mergeRow(card.rows, row) : card.rows,
    lastLine: row ? card.lastLine : text,
    lineCount: card.lineCount + 1,
    lastAt: at,
  };
}

function loadSession(sessionId: string): Map<string, Tracked> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const map = new Map<string, Tracked>();
  sessions.set(sessionId, map);
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionDir(sessionId)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return map;
  }
  const byMtime = files
    .map(f => {
      const full = path.join(sessionDir(sessionId), f);
      try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
    })
    .filter((x): x is { full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_CARDS_PER_SESSION);
  for (const { full } of byMtime) {
    const entries = readHistoryFile(full);
    const card = replayHistory(entries);
    if (!card) continue;
    map.set(card.toolUseId, {
      card,
      offset: 0,
      lastMtime: 0,
      partial: '',
      persistedLines: entries.filter(e => e.t === 'line').length,
      seenLive: false,
    });
  }
  return map;
}

/** Read newly appended bytes of the output file. Returns complete lines. */
function readNewLines(t: Tracked): string[] {
  if (!t.outputFile) return [];
  let st: fs.Stats;
  try {
    st = fs.statSync(t.outputFile);
  } catch {
    return [];
  }
  if (st.mtimeMs === t.lastMtime && st.size === t.offset) return [];
  t.lastMtime = st.mtimeMs;
  if (st.size < t.offset) {
    // truncated / rewritten — start over
    t.offset = 0;
    t.partial = '';
  }
  if (st.size === t.offset) return [];
  // Huge backlog (first sight of a chatty command): skip to the last window.
  const start = st.size - t.offset > MAX_READ_BYTES ? st.size - MAX_READ_BYTES : t.offset;
  if (start !== t.offset) t.partial = '';
  const len = Math.min(st.size - start, MAX_READ_BYTES);
  const buf = Buffer.alloc(len);
  let fd: number | undefined;
  try {
    fd = fs.openSync(t.outputFile, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  t.offset = start + len;
  const text = t.partial + buf.toString('utf-8');
  const parts = text.split('\n');
  t.partial = parts.pop() ?? '';
  // A TTY-style redraw never ends its line; cap so it can't grow unbounded.
  if (t.partial.length > MAX_READ_BYTES) t.partial = t.partial.slice(-4096);
  return parts;
}

function ingest(sessionId: string, t: Tracked, lines: string[], now: number): boolean {
  const entries: ProgressHistoryEntry[] = [];
  let changed = false;
  for (const raw of lines) {
    const text = cleanOutputLine(raw);
    if (!text) continue;
    const row = parseProgressLine(text, now) ?? undefined;
    t.card = applyLine(t.card, text, row, now);
    changed = true;
    if (row || t.persistedLines < MAX_PERSISTED_LINES) {
      entries.push(row ? { t: 'line', at: now, text, row } : { t: 'line', at: now, text });
      t.persistedLines++;
    }
  }
  persist(sessionId, t.card.toolUseId, entries);
  return changed;
}

function pushFinalStatus(card: BackgroundProgress): BackgroundProgressStatus | null {
  if (card.rows.length === 0 || card.rows.some(r => !r.final)) return null;
  if (card.rows.some(r => r.final === 'fail')) return 'failed';
  if (card.rows.some(r => r.final === 'stopped')) return 'stopped';
  return 'done';
}

function endPushCard(sessionId: string, t: Tracked, status: BackgroundProgressStatus, now: number): void {
  t.card = { ...t.card, status, endedAt: now };
  persist(sessionId, t.card.toolUseId, [{ t: 'end', at: now, status }]);
  endedPushCards.push({ sessionId, card: t.card });
}

/**
 * One `::progress` line POSTed by a watcher (bin/ovr-watch) — the path for
 * sessions whose harness writes no output file Overlord can tail (Codex).
 * Card key `push:<watchId>`. Returns true when the card changed.
 */
export function ingestPushed(sessionId: string, watchId: string, line: string, now = Date.now()): boolean {
  const map = loadSession(sessionId);
  const key = `push:${watchId}`;
  let t = map.get(key);
  const text = cleanOutputLine(line);
  if (!text) return false;
  const row = parseProgressLine(text, now);
  if (!t) {
    t = {
      card: {
        toolUseId: key,
        taskId: watchId,
        description: row?.label,
        startedAt: new Date(now).toISOString(),
        status: 'running',
        rows: [],
        lineCount: 0,
        source: 'push',
      },
      offset: 0,
      lastMtime: 0,
      partial: '',
      persistedLines: 0,
      seenLive: true,
    };
    map.set(key, t);
    persist(sessionId, key, [{ t: 'meta', toolUseId: key, taskId: watchId, description: row?.label, startedAt: t.card.startedAt, source: 'push' }]);
  }
  if (t.card.status !== 'running') return false;   // a late line after the end
  if (t.card.lastAt !== undefined) t.pushGapMs = now - t.card.lastAt;
  ingest(sessionId, t, [text], now);
  const final = pushFinalStatus(t.card);
  if (final) endPushCard(sessionId, t, final, now);
  return true;
}

/** Drain the push cards that ended since the last call. */
export function takeEndedPushCards(): EndedPushCard[] {
  return endedPushCards.splice(0, endedPushCards.length);
}

function endStatus(card: BackgroundProgress, notified: string | undefined): BackgroundProgressStatus {
  if (card.rows.some(r => r.final === 'fail')) return 'failed';
  if (notified === 'failed') return 'failed';
  if (notified === 'killed' || notified === 'stopped') return 'stopped';
  if (card.rows.some(r => r.final === 'stopped')) return 'stopped';
  return 'done';
}

/**
 * Advance every card of one session. `live` is the session's current
 * backgroundTasks; `statuses` the notification statuses seen this read.
 * Returns true when any card changed.
 */
export function syncSession(
  sessionId: string,
  live: BackgroundTask[] | undefined,
  statuses: Record<string, string> | undefined,
  now = Date.now(),
): boolean {
  // Nothing live and nothing loaded yet: skip the directory read entirely.
  if (!live?.length && !sessions.has(sessionId)) return false;
  const map = loadSession(sessionId);
  let changed = false;
  const liveIds = new Set<string>();

  for (const task of live ?? []) {
    liveIds.add(task.toolUseId);
    let t = map.get(task.toolUseId);
    if (!t) {
      t = {
        card: {
          toolUseId: task.toolUseId,
          taskId: task.taskId,
          description: task.description,
          command: task.command,
          startedAt: task.startedAt,
          status: 'running',
          rows: [],
          lineCount: 0,
        },
        outputFile: task.outputFile,
        offset: 0,
        lastMtime: 0,
        partial: '',
        persistedLines: 0,
        seenLive: true,
      };
      map.set(task.toolUseId, t);
      persist(sessionId, task.toolUseId, [{
        t: 'meta', toolUseId: task.toolUseId, taskId: task.taskId, description: task.description, command: task.command, startedAt: task.startedAt,
      }]);
      changed = true;
    } else if (!t.seenLive) {
      // Reloaded from disk after a restart and still running: resume reading
      // at the end of the file — the persisted history already has the rest.
      t.seenLive = true;
      t.outputFile = task.outputFile;
      try {
        const st = fs.statSync(task.outputFile ?? '');
        t.offset = st.size;
        t.lastMtime = st.mtimeMs;
      } catch { /* file gone; nothing to read */ }
      if (t.card.status !== 'running') {
        t.card = { ...t.card, status: 'running', endedAt: undefined };
        changed = true;
      }
    }
    if (t.card.status === 'running' && ingest(sessionId, t, readNewLines(t), now)) changed = true;
  }

  for (const t of map.values()) {
    if (t.card.source === 'push') {
      if (t.card.status !== 'running') continue;
      const lastMs = t.card.lastAt ?? Date.parse(t.card.startedAt ?? '');
      const cutoff = Math.max(PUSH_STALE_MIN_MS, 2 * (t.pushGapMs ?? 0) + 60_000);
      // Reloaded after a restart with no fresh line yet: same rule, from the last persisted line.
      if (Number.isFinite(lastMs) && now - lastMs > cutoff) {
        endPushCard(sessionId, t, 'stopped', now);
        changed = true;
      }
      continue;
    }
    if (t.card.status !== 'running' || liveIds.has(t.card.toolUseId)) continue;
    const notified = statuses?.[t.card.toolUseId];
    // End only on evidence: a notification, or the task left the live list
    // during this process. A card reloaded from disk waits for either, up to
    // the orphan TTL.
    if (notified === undefined && !t.seenLive) {
      const startedMs = t.card.startedAt ? Date.parse(t.card.startedAt) : NaN;
      if (Number.isFinite(startedMs) && now - startedMs <= ORPHAN_TTL_MS) continue;
    }
    const tail = readNewLines(t);
    if (t.partial) { tail.push(t.partial); t.partial = ''; }
    ingest(sessionId, t, tail, now);
    const status = endStatus(t.card, notified);
    t.card = { ...t.card, status, endedAt: now };
    persist(sessionId, t.card.toolUseId, [{ t: 'end', at: now, status }]);
    changed = true;
  }

  if (map.size > MAX_CARDS_PER_SESSION) {
    const evictable = [...map.values()]
      .filter(t => t.card.status !== 'running')
      .sort((a, b) => (a.card.endedAt ?? 0) - (b.card.endedAt ?? 0));
    for (const t of evictable.slice(0, map.size - MAX_CARDS_PER_SESSION)) map.delete(t.card.toolUseId);
  }
  return changed;
}

/** Cards for one session, oldest first. Loads persisted history on first use. */
export function getProgressCards(sessionId: string): BackgroundProgress[] {
  const map = loadSession(sessionId);
  return [...map.values()]
    .map(t => t.card)
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}

/** Full persisted history of one card, for the expanded view. */
export function getProgressHistory(sessionId: string, toolUseId: string): ProgressHistoryEntry[] {
  return readHistoryFile(historyFile(sessionId, toolUseId));
}

export function _resetProgressStoreForTest(): void {
  sessions.clear();
  endedPushCards.length = 0;
}
