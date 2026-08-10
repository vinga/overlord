import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WorkerState, Subagent, ActivityItem, PendingQuestion, PendingQuestionSet, ActiveMonitor, BackgroundTask } from '../types.js';
import { sessionStore } from './sessionStore.js';
import { shadowPathFor } from './transcriptShadow.js';
import { globalSettingsStore } from './globalSettingsStore.js';
import { parsePrUrl, prRefKey } from '../git/prRef.js';

const JIRA_MAX_KEYS = 5;

function getJiraProjectRegex(): RegExp | null {
  const raw = globalSettingsStore.get().jiraProjects;
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]{1,9}$/.test(s));
  if (tokens.length === 0) return null;
  // One alternation matched anywhere in the line, e.g. /\b(PROJ|BACKEND|API)-(\d{1,6})\b/g
  return new RegExp(String.raw`\b(${tokens.join('|')})-(\d{1,6})\b`, 'g');
}

/**
 * Walk last30 transcript JSONL lines once and return two text slices:
 *
 *   `user` — non-meta user text only. What a JIRA key or a slash-command name
 *            must come from (see the narrow-scan rationale below).
 *   `wide` — the same user text plus assistant text and tool_result output.
 *            What a PR *URL* may come from: `https://host/o/r/pull/819` is a
 *            concrete artifact, not a passing mention, and it is overwhelmingly
 *            printed by `gh pr create` / `gh pr view` (a tool_result) or
 *            reported by the assistant — almost never typed by the user. The
 *            ambiguity that forces the JIRA scan to stay narrow simply doesn't
 *            exist for a full URL.
 *
 * Both slices exclude `isMeta` user messages and tool_use *input* — skill-doc
 * expansions carry example ticket keys and PR links, and a Read of a doc is not
 * intent.
 *
 * One pass, because this runs on every transcript poll and tool_result blocks
 * are the largest thing in the file — a second JSON.parse sweep is not free.
 *
 * The `user` slice keeps only text segments where a JIRA reference would be
 * intentional:
 *   - non-meta user text content, including `<command-args>` carried inline in
 *     the plain user string of a slash-command invocation
 *
 * Scans ONLY user-authored text. Assistant text blocks are deliberately NOT
 * scanned: the model frequently *mentions* a ticket in prose — often to dismiss
 * it ("a different ticket BACKEND-2279 — irrelevant") — and the raw regex has no
 * notion of negation, so assistant prose was a major source of over-eager chips.
 * Tickets the user actually works on appear in their own messages / command args.
 *
 * Excludes tool_use input (file paths and skill-doc slugs cause false positives,
 * e.g. a Read of pr-start/SKILL.md picking up "BACKEND-2099-composer-integration"),
 * tool_result content, thinking blocks, system events.
 *
 * Also excludes `isMeta` user messages: these are slash-command / skill-body
 * expansions injected by the harness (e.g. the full /pr-start or /jira skill doc),
 * which carry example ticket IDs and curl payloads with related-issue links —
 * a major source of over-eager chips. The real command invocation (and its
 * `<command-args>` ticket) is a plain, non-meta user message and is kept.
 */
export function gatherScanSegments(last30: string[]): { user: string[]; wide: string[] } {
  const user: string[] = [];
  const wide: string[] = [];
  for (const line of last30) {
    if (!line) continue;
    let parsed: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
    if (parsed.type === 'user') {
      if (parsed.isMeta === true) continue;
      const c = parsed.message?.content;
      if (typeof c === 'string') {
        user.push(c);
        wide.push(c);
      } else if (Array.isArray(c)) {
        for (const block of c as Array<{ type?: string; text?: string; content?: unknown }>) {
          if (block.type === 'text' && typeof block.text === 'string') {
            user.push(block.text);
            wide.push(block.text);
          } else if (block.type === 'tool_result') {
            // wide-only: `gh pr create` prints the PR URL here
            pushToolResultText(block.content, wide);
          }
        }
      }
    } else if (parsed.type === 'assistant') {
      // wide-only — assistant prose is a major source of over-eager JIRA chips
      // (see doc above) but is a legitimate source of PR links.
      const c = parsed.message?.content;
      if (typeof c === 'string') {
        wide.push(c);
      } else if (Array.isArray(c)) {
        for (const block of c as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && typeof block.text === 'string') wide.push(block.text);
          // skip tool_use input, thinking
        }
      }
    }
  }
  return { user, wide };
}

/** tool_result `content` is either a plain string or a block array. */
function pushToolResultText(content: unknown, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
}

/**
 * Extract JIRA ticket keys whose project prefix is in the configured allowlist.
 * Returns empty when no allowlist is set — chips are opt-in.
 * - First-occurrence order, de-duplicated, capped at JIRA_MAX_KEYS.
 */
export function extractJiraKeys(segments: string[], projectRegex: RegExp | null): string[] {
  if (!projectRegex) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment.length < 4) continue;
    projectRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = projectRegex.exec(segment)) !== null) {
      const key = `${m[1]}-${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= JIRA_MAX_KEYS) return out;
    }
  }
  return out;
}

const PR_REFS_MAX = 5;
const URL_SWEEP = /https?:\/\/[^\s<>"'`\\)]+/g;

/**
 * Extract pull-request refs (`owner/repo#number`) from the wide scan slice.
 *
 * Last-occurrence wins, unlike extractJiraKeys' first-occurrence rule: in a long
 * session the PR you're on is the one most recently printed, so when the cap
 * bites we keep the newest mentions. The returned list is chronological
 * (oldest → newest) so it merges stably with the persisted list.
 */
export function extractPrRefs(segments: string[]): string[] {
  const found: string[] = [];
  for (const segment of segments) {
    if (!segment || !segment.includes('/pull/')) continue;
    URL_SWEEP.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_SWEEP.exec(segment)) !== null) {
      const ref = parsePrUrl(m[0]);
      if (ref) found.push(ref);
    }
  }
  if (found.length === 0) return [];
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = found.length - 1; i >= 0; i--) {
    const key = prRefKey(found[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    newestFirst.push(found[i]);
    if (newestFirst.length >= PR_REFS_MAX) break;
  }
  return newestFirst.reverse();
}

const SKILLS_USED_MAX = 12;
// Built-in commands that aren't skills. Everything else arriving as a
// <command-name> invocation is assumed to be a skill/workflow command.
const IGNORED_COMMANDS = new Set([
  'compact', 'clear', 'exit', 'login', 'logout', 'resume',
  'status', 'model', 'help', 'cost', 'doctor',
]);

/**
 * Extract skill/command names from slash-command invocations. Reuses the
 * `user` segments from gatherScanSegments: the real invocation is a plain, non-meta
 * user message whose content STARTS with the command tags (either
 * `<command-name>` first or `<command-message>` first). Anchoring to the
 * segment start is load-bearing: user prose (e.g. compaction summaries) can
 * quote `<command-name>` tags mid-text and must not count as an invocation.
 * First-occurrence order, de-duplicated, capped at SKILLS_USED_MAX.
 */
const COMMAND_INVOCATION_RE =
  /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\/([a-z0-9:_-]+)<\/command-name>/i;

export function extractSkillsUsed(segments: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const m = COMMAND_INVOCATION_RE.exec(segment);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (IGNORED_COMMANDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= SKILLS_USED_MAX) break;
  }
  return out;
}

/**
 * Model-invoked skills: the assistant calls the `Skill` tool (input.skill) or
 * `SlashCommand` tool (input.command) without the user ever typing a slash, so
 * these never appear as `<command-name>` user entries.
 *
 * Sidechain (subagent) entries are skipped — a skill a subagent loads belongs to
 * that subagent, not to this session's chip list.
 */
export function extractSkillToolUses(last30: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of last30) {
    if (!line || !line.includes('tool_use')) continue;
    let parsed: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
    if (parsed.type !== 'assistant' || parsed.isSidechain === true) continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string; input?: { skill?: string; command?: string } }>) {
      if (block.type !== 'tool_use') continue;
      let raw: string | undefined;
      if (block.name === 'Skill') raw = block.input?.skill;
      else if (block.name === 'SlashCommand') raw = block.input?.command;
      if (typeof raw !== 'string') continue;
      const name = raw.trim().split(/\s+/)[0].replace(/^\//, '').toLowerCase();
      if (!name || IGNORED_COMMANDS.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= SKILLS_USED_MAX) return out;
    }
  }
  return out;
}

/** First-occurrence union of skill-name lists, capped at SKILLS_USED_MAX. */
export function unionSkillNames(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const name of list) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= SKILLS_USED_MAX) return out;
    }
  }
  return out;
}

interface TranscriptCache {
  mtimeMs: number;
  fileSize: number;
  fileModifiedMs: number; // raw mtime for age calculation
  lastCheckedAt: number; // wall-clock time of last stat() call
  /** Which state-determination branch to use when re-evaluating from time alone */
  stateHint: 'tool_use' | 'ask_user_question' | 'assistant_text' | 'tool_result' | 'user_input' | 'none' | 'codex_reasoning';
  result: ReturnType<typeof readTranscriptState>;
  dirty: boolean; // set by markDirty() when chokidar fires
  // Incremental-tail state (claude path only). parsedTailLines is exactly what
  // readFileTail() last returned; parsedUpToBytes is the byte offset through which
  // COMPLETE lines have been consumed (== fileSize when the file ended on a newline).
  // On an append-only grow these let us read just the new bytes instead of
  // re-parsing the whole multi-MB tail window every 3s poll.
  parsedTailLines?: string[];
  parsedUpToBytes?: number;
  /** Pending `Bash(run_in_background: true)` commands, keyed by tool_use id.
   *  Sticky across parses: a background command can outlive the tail window, so
   *  entries are carried forward and dropped only on an observed
   *  <task-notification>, on /clear, or by TTL. See BACKGROUND_TASK_TTL_MS. */
  pendingBackgroundTasks?: Map<string, BackgroundTask>;
}
const transcriptCache = new Map<string, TranscriptCache>();

// Minimum interval between stat() calls on the same file (ms).
const MIN_STAT_INTERVAL_MS = 1000;

// Cache compaction counts so we don't need to re-read entire files
interface CompactCache {
  fileSize: number; // last known file size we scanned up to
  compactCount: number;
  lastCompactTimestamp?: number;
}
const compactCountCache = new Map<string, CompactCache>();

// Bound transcriptCache memory. Each entry holds a full activityFeed (up to 100
// msgs x 10 KB + thinking + tool results) => 1-3 MB. Entries are self-rebuilding
// from disk, so LRU + idle eviction is safe and acts as a backstop for entries
// clearSessionCaches never reaches — notably subagent transcripts (keyed by their
// own .jsonl path) and stale post-/clear sessionIds.
const MAX_TRANSCRIPT_CACHE_ENTRIES = 300;
const TRANSCRIPT_CACHE_IDLE_MS = 10 * 60_000; // drop entries untouched for 10 min
const MAX_COMPACT_CACHE_ENTRIES = 1000; // tiny per-entry; cap by count only

/**
 * Backstop eviction for transcriptCache, called after each set(). Drops entries
 * idle past TRANSCRIPT_CACHE_IDLE_MS, then, if still over the count cap, evicts
 * the least-recently-read (oldest lastCheckedAt) until back under cap.
 */
function evictTranscriptCache(now: number): void {
  for (const [key, entry] of transcriptCache) {
    if (now - entry.lastCheckedAt > TRANSCRIPT_CACHE_IDLE_MS) transcriptCache.delete(key);
  }
  if (transcriptCache.size <= MAX_TRANSCRIPT_CACHE_ENTRIES) return;
  const byAge = [...transcriptCache.entries()].sort((a, b) => a[1].lastCheckedAt - b[1].lastCheckedAt);
  const overflow = transcriptCache.size - MAX_TRANSCRIPT_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i++) transcriptCache.delete(byAge[i][0]);
}

/** Test-only: current entry counts for the bounded caches. */
export function _cacheSizesForTest(): { transcript: number; compact: number } {
  return { transcript: transcriptCache.size, compact: compactCountCache.size };
}

/** Test-only: counts which tail-read branch ran, so tests can prove the append-only
 *  fast path actually fired instead of silently falling back to a full read. */
export const _tailReadStatsForTest = { full: 0, incremental: 0 };

/** Test-only: wipe the bounded caches so module-global state can't leak across tests. */
export function _resetCachesForTest(): void {
  transcriptCache.clear();
  compactCountCache.clear();
  _tailReadStatsForTest.full = 0;
  _tailReadStatsForTest.incremental = 0;
}

/** Count-only cap for compactCountCache: drop oldest by Map insertion order. */
function evictCompactCache(): void {
  while (compactCountCache.size > MAX_COMPACT_CACHE_ENTRIES) {
    const oldest = compactCountCache.keys().next().value;
    if (oldest === undefined) break;
    compactCountCache.delete(oldest);
  }
}

interface SubagentsDirCache {
  mtimeMs: number;
  agentIds: string[];
}
const subagentsDirCache = new Map<string, SubagentsDirCache>();

const proposedNameCache = new Map<string, string>();

export function clearTranscriptCache(filePath: string): void {
  transcriptCache.delete(filePath);
  compactCountCache.delete(filePath);
}

/** Drop every cached entry tied to a specific session. Called on session delete / GC. */
export function clearSessionCaches(
  sessionId: string,
  transcriptPath?: string | null,
  cwd?: string,
): void {
  proposedNameCache.delete(sessionId);
  if (transcriptPath) {
    transcriptCache.delete(transcriptPath);
    compactCountCache.delete(transcriptPath);
    const subagentsDir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
    subagentsDirCache.delete(subagentsDir);
  }
  if (cwd) {
    const fallbackSubagentsDir = path.join(os.homedir(), '.claude', 'projects', cwdToSlug(cwd), sessionId, 'subagents');
    subagentsDirCache.delete(fallbackSubagentsDir);
  }
}

/**
 * Mark a transcript file as dirty — called by chokidar when the file changes.
 * The next readTranscriptState() call will re-read the file instead of
 * just re-evaluating time-based state from cache.
 */
export function markTranscriptDirty(filePath: string): void {
  const cached = transcriptCache.get(filePath);
  if (cached) cached.dirty = true;
}

/**
 * Re-evaluate isCompacting from the compactCountCache. The 5s window is
 * time-dependent, so fast-path returns must not freeze this field — the
 * compact_boundary can land within 5s of the final transcript write, which
 * would otherwise strand `isCompacting: true` until the next file change.
 */
function reEvalCompactingFromCache(filePath: string): true | undefined {
  const cc = compactCountCache.get(filePath);
  if (cc?.lastCompactTimestamp === undefined) return undefined;
  return Date.now() - cc.lastCompactTimestamp < 5000 ? true : undefined;
}

// Keep showing "scheduled" briefly past the fire time — the harness re-invoke
// takes a few seconds; without grace the badge flaps to "waiting" right before
// the wakeup lands. If the session died, the badge self-expires after this.
const SCHEDULED_WAKEUP_GRACE_MS = 30_000;

/**
 * Time-only re-evaluation of a cached scheduledWakeupAt: keep it while the
 * fire time (+ grace) is in the future, clear it once passed. Mirrors the
 * reEvalCompactingFromCache pattern — the fast paths must not freeze this.
 */
function reEvalScheduledWakeup(prev: number | undefined): number | undefined {
  if (prev === undefined) return undefined;
  return Date.now() < prev + SCHEDULED_WAKEUP_GRACE_MS ? prev : undefined;
}

// Safety valve for the sticky pending-background-task map. A notification can be
// missed (server down across the completion, or the whole exchange scrolls out of
// the tail window before we ever parse it), and without a TTL such an entry would
// pin a "running" bubble forever. 6h is well past any realistic background command.
const BACKGROUND_TASK_TTL_MS = 6 * 60 * 60 * 1000;

// The tool_result text the harness writes back for a backgrounded Bash. This — not
// the `run_in_background` input — is the launch confirmation: it is the only place
// carrying the shell id and the output path.
// The path is matched greedily: `\S+?\.` would stop at the first dot and truncate
// "…/bw5hy60h4.output" to "…/bw5hy60h4". Greedy + trailing `\.` backtracks to the
// sentence-ending period instead.
const BACKGROUND_LAUNCH_RE = /Command running in background with ID: ([^\s.]+)\. Output is being written to: (\S+)\./;

// Completion arrives as a <task-notification> block on three separate lines
// (queue-operation enqueue, queue-operation remove, attachment/queued_command).
// Statuses seen in the wild: completed, failed, stopped — all terminal, so the
// presence of a notification is the signal and <status> is not parsed at all.
const TASK_NOTIFICATION_TOOL_USE_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/;

/**
 * Extract the tool-use-id from any line shape carrying a <task-notification>.
 * Returns undefined for every other line.
 */
function parseTaskNotificationToolUseId(parsed: {
  type?: string;
  content?: unknown;
  attachment?: { commandMode?: string; prompt?: string };
}): string | undefined {
  let xml: string | undefined;
  if (parsed.type === 'queue-operation' && typeof parsed.content === 'string') {
    xml = parsed.content;
  } else if (parsed.attachment?.commandMode === 'task-notification' && typeof parsed.attachment.prompt === 'string') {
    xml = parsed.attachment.prompt;
  }
  if (!xml || !xml.includes('<task-notification>')) return undefined;
  return TASK_NOTIFICATION_TOOL_USE_RE.exec(xml)?.[1];
}

/**
 * Re-evaluate the time-dependent state from a cached stateHint without any file I/O.
 * Returns null if the state hasn't changed (caller can skip broadcasting).
 */
function reEvalStateFromCache(cached: TranscriptCache): { state: WorkerState; needsPermission?: boolean } {
  const ageSec = (Date.now() - cached.fileModifiedMs) / 1000;
  const isBypass = cached.result.permissionMode === 'bypassPermissions';
  // After 2 minutes of no file updates, assume the session/subagent is stale
  // But still check for pending tool_use → permission prompt
  if (ageSec > 120) {
    if (cached.stateHint === 'tool_use') return { state: 'waiting', needsPermission: isBypass ? undefined : true };
    // ask_user_question stays waiting without permission flag
    return { state: 'waiting' };
  }
  switch (cached.stateHint) {
    case 'tool_use': {
      // Collapse middle band: go directly working → waiting. 'thinking' is only
      // emitted by evidence-based paths (codex_reasoning, recent thinking block).
      // 20s threshold: Explore/fast agents routinely take 10-15s per tool call,
      // causing false waiting blinks at the old 5s threshold.
      const state: WorkerState = ageSec < 20 ? 'working' : 'waiting';
      // Tool pending >25s with no result → likely permission prompt (not in bypass mode)
      const needsPermission = ageSec > 25 && !isBypass ? true : undefined;
      return { state, needsPermission };
    }
    case 'ask_user_question': {
      // AskUserQuestion — never a permission prompt, just goes to waiting
      const state: WorkerState = ageSec < 5 ? 'working' : 'waiting';
      return { state };
    }
    case 'assistant_text': {
      const state: WorkerState = ageSec < 5 ? 'working' : 'waiting';
      return { state };
    }
    case 'tool_result':  return { state: ageSec < 8 ? 'working' : 'waiting' };
    case 'user_input':   return { state: ageSec < 8 ? 'working' : 'waiting' };
    case 'codex_reasoning': return { state: ageSec < 6 ? 'thinking' : 'working' };
    case 'none':         return { state: 'waiting' };
  }
}

function isCodexTranscript(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').includes('/.codex/sessions/');
}

export function clearProposedNameCache(sessionId: string): void {
  proposedNameCache.delete(sessionId);
}

/** Look up shadow path for a sessionId via sessionStore (ovrId required). */
function findShadowTranscript(sessionId: string): string | null {
  const rec = sessionStore.getBySessionId(sessionId);
  if (!rec?.overlordId) return null;
  const shadow = shadowPathFor(rec.overlordId, sessionId);
  try { return fs.existsSync(shadow) ? shadow : null; } catch { return null; }
}

export function cwdToSlug(cwd: string): string {
  // Match Claude's actual project-dir scheme exactly: replace \, :, / with -
  // and PRESERVE the leading dash. Claude writes its transcripts under
  // ~/.claude/projects/-Users-foo-bar/<sessionId>.jsonl (with leading dash);
  // stripping it caused findTranscriptPath to miss the canonical file and
  // fall through to the (potentially stale) shadow copy, which made the UI
  // appear frozen for sessions whose canonical was being updated externally
  // (e.g. a user-driven `claude --resume` not spawned via auto-resume).
  return cwd.replace(/[\\:/]/g, '-');
}

export function findTranscriptPath(cwd: string, sessionId: string): string | null {
  const slug = cwdToSlug(cwd);
  const filePath = path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  } catch {
    // ignore
  }
  return findShadowTranscript(sessionId);
}

/**
 * When a session's transcript is stale (>1h old) but the process is alive, the session
 * may have been /clear'd — Claude creates a new sessionId + transcript but the session
 * file still references the old one. Scan the project dir for a recently-modified
 * transcript that isn't already tracked by another session.
 *
 * To verify ownership, read the first 4KB of the candidate and check if it references
 * the stale session's ID (e.g. in task output paths or queue operations).
 */
export function findFresherTranscript(cwd: string, excludeSessionId: string, knownSessionIds: Set<string>): string | null {
  const slug = cwdToSlug(cwd);
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);
  try {
    const files = fs.readdirSync(dir);
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sid = file.replace('.jsonl', '');
      if (sid === excludeSessionId) continue;
      if (knownSessionIds.has(sid)) continue;
      const full = path.join(dir, file);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (Date.now() - stat.mtimeMs > 3600_000) continue;
        candidates.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }
    // Sort by most recent first
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Verify ownership: read head of candidate, check if it references the stale sessionId
    for (const c of candidates) {
      try {
        const fd = fs.openSync(c.path, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const head = buf.toString('utf-8', 0, bytesRead);
        if (head.includes(excludeSessionId)) {
          return c.path;
        }
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

/**
 * Read the first few substantive user messages from the start of a transcript.
 * Returns them joined so Haiku can infer the real task even if the first message
 * is trivial ("continue", "ok", etc.).
 */
export function readFirstUserMessage(transcriptPath: string): string {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    let content = '';
    try {
      const buf = Buffer.alloc(96 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      content = buf.slice(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = content.split('\n');
    const collected: string[] = [];
    for (const line of lines) {
      if (!line.trim() || collected.length >= 4) break;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
          payload?: { role?: string; content?: Array<{ text?: string }> };
        };
        let text = '';
        // Claude format
        if (parsed.type === 'user') {
          const c = parsed.message?.content;
          const arr = Array.isArray(c) ? c : [];
          const textBlock = arr.find((b: { type?: string; text?: string }) => b.type === 'text');
          text = (typeof textBlock?.text === 'string' ? textBlock.text : typeof c === 'string' ? c : '').trim();
          if (text.startsWith('<environment_details') || text.startsWith('<local-command') || text.startsWith('<command-name>')) text = '';
          // Strip trailing environment/system blocks appended to user messages
          const envIdx = text.indexOf('<environment_details');
          if (envIdx > 0) text = text.slice(0, envIdx).trim();
        }
        // Codex format
        if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
          const raw = (parsed.payload.content ?? []).map((b) => b.text ?? '').join(' ').trim();
          if (!raw.startsWith('<environment_context>')) text = raw;
        }
        if (text.length >= 8) collected.push(text.slice(0, 300));
      } catch { /* skip malformed lines */ }
    }
    return collected.join('\n\n---\n\n');
  } catch { /* ignore */ }
  return '';
}

/**
 * Resolve a resumable sessionId + transcript path.
 *
 * When `claude --resume <id>` is invoked, Claude needs `{id}.jsonl` to exist on disk.
 * After a resume, Claude may keep appending to the parent's jsonl and never create
 * `{currentSessionId}.jsonl` — leaving the session unresumable by currentSessionId.
 *
 * Fallback: walk `lineage.history` newest→oldest (then `resumedFrom`) for a sessionId
 * whose jsonl does exist, and resume that one instead.
 */
export function resolveResumableSessionId(
  sessionId: string,
  cwd: string,
): { sessionId: string; transcriptPath: string } | null {
  const primary = findTranscriptPath(cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
  if (primary) return { sessionId, transcriptPath: primary };

  const ovr = sessionStore.getBySessionId(sessionId);
  if (!ovr) return null;

  const history = [...ovr.lineage.history].reverse();
  for (const entry of history) {
    if (entry.sessionId === sessionId) continue;
    const p = findTranscriptPath(cwd, entry.sessionId) ?? findTranscriptPathAnywhere(entry.sessionId);
    if (p) return { sessionId: entry.sessionId, transcriptPath: p };
  }
  if (ovr.resumedFrom && ovr.resumedFrom !== sessionId) {
    const p = findTranscriptPath(cwd, ovr.resumedFrom) ?? findTranscriptPathAnywhere(ovr.resumedFrom);
    if (p) return { sessionId: ovr.resumedFrom, transcriptPath: p };
  }
  return null;
}

export function findTranscriptPathAnywhere(sessionId: string): string | null {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return null;
    const slugDirs = fs.readdirSync(projectsDir);
    for (const slug of slugDirs) {
      const candidate = path.join(projectsDir, slug, `${sessionId}.jsonl`);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return findShadowTranscript(sessionId);
}

/**
 * Read the tail of a file, guaranteeing at least TARGET_LINES complete JSONL lines.
 *
 * Problem with a fixed byte window: a single tool_result line can be 3MB+, so a 2MB
 * window captures nothing but the middle of that one line — user messages before it vanish.
 *
 * Fix: start with INITIAL_TAIL_BYTES; if we get fewer than TARGET_LINES complete lines,
 * double the window and retry. Cap at MAX_TAIL_BYTES or the full file size.
 * Fast path (small file or normal line sizes) is unchanged — only one read.
 */
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;  // 2MB first attempt
const MAX_TAIL_BYTES     = 32 * 1024 * 1024; // 32MB hard cap
const TARGET_LINES = 500; // minimum complete lines before we stop expanding

function readFileTail(filePath: string, fileSize: number): string[] {
  if (fileSize <= INITIAL_TAIL_BYTES) {
    // Small file — read it all, every line is complete
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter((l) => l.trim().length > 0);
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    let windowSize = INITIAL_TAIL_BYTES;

    while (true) {
      const offset   = Math.max(0, fileSize - windowSize);
      const readSize = fileSize - offset;
      const buf      = Buffer.alloc(readSize);
      const bytesRead = fs.readSync(fd, buf, 0, readSize, offset);
      const raw   = buf.toString('utf-8', 0, bytesRead);
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);

      if (offset === 0) {
        // Read the entire file — all lines are complete, return as-is
        return lines;
      }

      // Drop first line — it started mid-file so it may be a partial record
      const completeLines = lines.length > 1 ? lines.slice(1) : [];

      if (completeLines.length >= TARGET_LINES || windowSize >= MAX_TAIL_BYTES) {
        // Enough lines, or hit the cap — return what we have
        return completeLines;
      }

      // Too few complete lines (giant lines dominate the window) — double and retry
      windowSize = Math.min(windowSize * 2, MAX_TAIL_BYTES, fileSize);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Cheap 1-byte read: does the file end on a newline (a clean line boundary)? */
function fileEndsWithNewline(filePath: string, fileSize: number): boolean {
  if (fileSize <= 0) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, fileSize - 1);
    return buf[0] === 0x0a;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append-only fast path for readFileTail: given the lines we last parsed and the
 * byte offset we consumed up to, read ONLY the bytes appended since then, merge the
 * new complete lines into the retained buffer, and trim the buffer back to the same
 * INITIAL_TAIL_BYTES window readFileTail would use — so the returned lines are
 * byte-for-byte what a fresh readFileTail() would produce.
 *
 * Returns null when the incremental assumptions don't hold (caller falls back to a
 * full readFileTail): no prior buffer, file shrank/unchanged, the appended chunk
 * would leave fewer than TARGET_LINES after trimming (giant-line case that
 * readFileTail handles by expanding its window), or a read error.
 *
 * The parsed offset always sits just after a `\n` (a single ASCII byte, never part
 * of a multi-byte UTF-8 sequence), so reading [fromBytes, fileSize) never splits a
 * character. A trailing partial line (write in flight) is dropped and its bytes are
 * NOT consumed — parsedUpToBytes stops before it so the next poll re-reads it.
 */
function readFileTailIncremental(
  filePath: string,
  fileSize: number,
  prevLines: string[],
  fromBytes: number,
): { lines: string[]; parsedUpToBytes: number } | null {
  if (fromBytes <= 0 || fileSize <= fromBytes) return null;
  let raw: string;
  const fd = fs.openSync(filePath, 'r');
  try {
    const readSize = fileSize - fromBytes;
    const buf = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buf, 0, readSize, fromBytes);
    raw = buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }

  // A trailing partial line has no closing newline. Consume only up to the last one.
  const endsWithNewline = raw.endsWith('\n');
  const partialBytes = endsWithNewline ? 0 : Buffer.byteLength(raw.slice(raw.lastIndexOf('\n') + 1), 'utf-8');
  const newLines = raw.split('\n').filter((l) => l.trim().length > 0);
  const completeNew = endsWithNewline ? newLines : newLines.slice(0, -1);
  if (completeNew.length === 0) return null;

  const merged = prevLines.concat(completeNew);

  // Trim from the front to match readFileTail's INITIAL_TAIL_BYTES window.
  let budget = INITIAL_TAIL_BYTES;
  let keepFrom = merged.length;
  for (let i = merged.length - 1; i >= 0; i--) {
    budget -= Buffer.byteLength(merged[i], 'utf-8') + 1; // +1 for the newline
    if (budget < 0) break;
    keepFrom = i;
  }
  const trimmed = keepFrom > 0 ? merged.slice(keepFrom) : merged;
  // Giant-line case: readFileTail would have expanded its window past 2MB to reach
  // TARGET_LINES. We can't reproduce that from the buffer alone — fall back.
  if (keepFrom > 0 && trimmed.length < TARGET_LINES) return null;

  return { lines: trimmed, parsedUpToBytes: fileSize - partialBytes };
}

/**
 * Incrementally scan for compact_boundary events.
 * Only reads new content since the last scan, caching the count.
 */
function detectCompactionIncremental(filePath: string, fileSize: number): { compactCount: number; isCompacting: boolean } {
  const cached = compactCountCache.get(filePath);
  const now = Date.now();

  // If the file shrank (transcript replaced during compaction), reset the cache
  // so we re-scan from the beginning of the new file.
  const fileShrank = cached && fileSize < cached.fileSize;
  let compactCount = fileShrank ? 0 : (cached?.compactCount ?? 0);
  let lastCompactTimestamp = fileShrank ? undefined : cached?.lastCompactTimestamp;
  const scanFrom = fileShrank ? 0 : (cached?.fileSize ?? 0);

  if (scanFrom < fileSize) {
    // Read only the new portion of the file
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunkSize = fileSize - scanFrom;
      const buf = Buffer.alloc(chunkSize);
      fs.readSync(fd, buf, 0, chunkSize, scanFrom);
      const raw = buf.toString('utf-8');
      // Quick string check before JSON parsing — much faster for large chunks
      if (raw.includes('compact_boundary')) {
        for (const line of raw.split('\n')) {
          if (!line.includes('compact_boundary')) continue;
          try {
            const parsed = JSON.parse(line) as { type?: string; subtype?: string; timestamp?: string };
            if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
              compactCount++;
              if (parsed.timestamp) {
                const ts = new Date(parsed.timestamp).getTime();
                if (!isNaN(ts) && (lastCompactTimestamp === undefined || ts > lastCompactTimestamp)) {
                  lastCompactTimestamp = ts;
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  compactCountCache.set(filePath, { fileSize, compactCount, lastCompactTimestamp });
  evictCompactCache();

  const isCompacting = lastCompactTimestamp !== undefined && now - lastCompactTimestamp < 5000;
  return { compactCount, isCompacting };
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // AskUserQuestion: surface the actual question(s) so the feed row isn't blank.
  if (Array.isArray(obj.questions)) {
    const qs = (obj.questions as Array<{ question?: unknown }>)
      .map(q => (typeof q?.question === 'string' ? q.question : ''))
      .filter(Boolean);
    if (qs.length > 0) return qs.join(' · ').slice(0, 200);
  }
  // file_path must survive intact: the client uses it verbatim to fetch the file
  // for the diff viewer, so a 100-char cut turns into "File unavailable".
  // PATH_MAX is 1024 on darwin/linux — that is the only bound needed here.
  if (typeof obj.file_path === 'string') return obj.file_path.slice(0, 1024);
  const val = obj.description ?? obj.command ?? obj.pattern ?? obj.prompt ?? obj.query ?? '';
  return String(val).slice(0, 100);
}

function buildToolDurations(lines: string[]): Map<string, number> {
  const toolStartMs = new Map<string, number>();
  const toolEndMs = new Map<string, number>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        message?: {
          content?: Array<{ type?: string; id?: string; tool_use_id?: string }>;
        };
      };
      if (parsed.type === 'assistant' && parsed.timestamp && Array.isArray(parsed.message?.content)) {
        const ts = Date.parse(parsed.timestamp);
        if (!isNaN(ts)) {
          for (const block of parsed.message!.content!) {
            if (block.type === 'tool_use' && block.id) {
              toolStartMs.set(block.id, ts);
            }
          }
        }
      } else if (parsed.type === 'user' && parsed.timestamp && Array.isArray(parsed.message?.content)) {
        const ts = Date.parse(parsed.timestamp);
        if (!isNaN(ts)) {
          for (const block of parsed.message!.content!) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              toolEndMs.set(block.tool_use_id, ts);
            }
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  const durationMs = new Map<string, number>();
  for (const [id, start] of toolStartMs) {
    const end = toolEndMs.get(id);
    if (end !== undefined && end > start) {
      durationMs.set(id, end - start);
    }
  }
  return durationMs;
}

const MAX_RESULT_LENGTH = 3000;

/** Cap for conversational message text. Deliberately higher than the 10k cap used
 *  for tool fields: plans and specs routinely run past 10k, and the shared cap cut
 *  them mid-word with no marker, so a partial message was indistinguishable from a
 *  complete one. Anything still over this sets `contentTruncated` so the UI can say so. */
const MAX_MESSAGE_LENGTH = 32000;

function capMessage(t: string): { content: string; contentTruncated?: true } {
  return t.length > MAX_MESSAGE_LENGTH
    ? { content: t.slice(0, MAX_MESSAGE_LENGTH), contentTruncated: true }
    : { content: t };
}

/** Claude appends "(disable recaps in /config)" to every away_summary. It is a TUI
 *  hint, not part of the recap — drop it before it reaches the conversation feed. */
function stripRecapFooter(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
}

function buildToolResults(lines: string[]): Map<string, { content: string; isError: boolean }> {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: Array<{
            type?: string;
            tool_use_id?: string;
            content?: string | Array<{ type?: string; text?: string }>;
            is_error?: boolean;
          }>;
        };
      };
      if (parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
        for (const block of parsed.message!.content!) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            let text = '';
            if (typeof block.content === 'string') {
              text = block.content;
            } else if (Array.isArray(block.content)) {
              text = block.content
                .filter(b => b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text!)
                .join('\n');
            }
            if (text.length > MAX_RESULT_LENGTH) {
              text = text.slice(0, MAX_RESULT_LENGTH) + '…';
            }
            results.set(block.tool_use_id, { content: text, isError: block.is_error === true });
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

/** One ScheduleWakeup call mined from the transcript tail — for the on-demand
 *  Detail-panel stats endpoint. Not part of the WS snapshot. */
export interface ScheduledWakeupInfo {
  scheduledAt?: string;   // ISO timestamp of the tool_use
  fireAt?: number;        // epoch ms (absent for stop calls)
  delaySeconds?: number;  // raw input value (pre-clamp)
  reason?: string;
  prompt?: string;
  status: 'pending' | 'fired' | 'stopped' | 'superseded' | 'unconfirmed';
}

const MAX_WAKEUP_HISTORY = 10;

/**
 * All ScheduleWakeup calls in the transcript tail, newest first (capped at 10).
 * Only the newest entry can be 'pending' — every ScheduleWakeup call replaces
 * the previous pending wakeup, so older ones are 'superseded' (or 'stopped').
 * Reads the tail directly (no shared cache mutation) — this is an on-demand
 * REST path, not the 3s poll.
 */
export function readScheduledWakeups(filePath: string): ScheduledWakeupInfo[] {
  let lines: string[];
  try {
    const stat = fs.statSync(filePath);
    lines = readFileTail(filePath, stat.size);
  } catch {
    return [];
  }
  const toolResults = buildToolResults(lines);
  const out: ScheduledWakeupInfo[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_WAKEUP_HISTORY; i--) {
    let parsed: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try { parsed = JSON.parse(lines[i]) as typeof parsed; } catch { continue; }
    if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content)) continue;
    const blocks = parsed.message!.content as Array<{ type?: string; name?: string; id?: string; input?: unknown }>;
    for (let j = blocks.length - 1; j >= 0 && out.length < MAX_WAKEUP_HISTORY; j--) {
      const block = blocks[j];
      if (block.type !== 'tool_use' || block.name !== 'ScheduleWakeup') continue;
      const inp = (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {};
      const res = block.id ? toolResults.get(block.id) : undefined;
      const isStop = inp.stop === true;
      const delaySeconds = typeof inp.delaySeconds === 'number' ? inp.delaySeconds : undefined;
      let fireAt: number | undefined;
      if (!isStop && delaySeconds !== undefined && parsed.timestamp) {
        const t = Date.parse(parsed.timestamp) + Math.min(3600, Math.max(60, delaySeconds)) * 1000;
        if (Number.isFinite(t)) fireAt = t;
      }
      let status: ScheduledWakeupInfo['status'];
      if (isStop) {
        status = 'stopped';
      } else if (!res || res.isError) {
        status = 'unconfirmed';
      } else if (out.length > 0) {
        status = 'superseded';
      } else if (fireAt !== undefined && Date.now() < fireAt + SCHEDULED_WAKEUP_GRACE_MS) {
        status = 'pending';
      } else {
        status = 'fired';
      }
      out.push({
        scheduledAt: parsed.timestamp,
        fireAt,
        delaySeconds,
        reason: typeof inp.reason === 'string' ? inp.reason : undefined,
        prompt: typeof inp.prompt === 'string' ? inp.prompt : undefined,
        status,
      });
    }
  }
  return out;
}

export function readTranscriptState(filePath: string): {
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  needsPermission?: boolean;
  permissionPromptText?: string;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
  // true iff the file on disk is smaller than the last cached size — a signal
  // that the transcript was rewritten in place (e.g. /clear inside a --resume'd
  // session, which keeps the same sessionId and same file path). Jsonl
  // transcripts are append-only under normal operation, so shrinkage ⇒ clear.
  transcriptTruncated?: boolean;
  // Approved plans detected via ExitPlanMode tool_use in this transcript.
  // stateManager dedupes on planToolUseId and persists as plan-kind Tasks.
  detectedPlans?: Array<{ planToolUseId: string; plan: string; timestamp?: string; planStatus: 'approved' | 'rejected' | 'pending' }>;
  // In-flight Monitor tool_use blocks — present while streaming (no tool_result yet).
  activeMonitors?: ActiveMonitor[];
  // Epoch ms when a pending ScheduleWakeup fires — see the ScheduleWakeup block below.
  scheduledWakeupAt?: number;
  // The `reason` input of that pending call — one sentence, shown in the UI.
  scheduledWakeupReason?: string;
  // Launched-but-unfinished `Bash(run_in_background: true)` commands. Sticky across
  // reads (see TranscriptCache.pendingBackgroundTasks) — unlike scheduledWakeupAt
  // these outlive the tail window, so they cannot be re-derived by a bounded scan.
  backgroundTasks?: BackgroundTask[];
  // JIRA-shaped ticket keys mined from the transcript tail. Capped at 5.
  jiraKeys?: string[];
  // `owner/repo#number` refs from PR URLs in the tail (wider scan). Capped at 5.
  prRefs?: string[];
  // Skill/command names from slash-command invocations in the tail. Capped at 12.
  skillsUsed?: string[];
} {
  if (isCodexTranscript(filePath)) {
    return readCodexTranscriptState(filePath);
  }
  try {
    const now = Date.now();
    const cached = transcriptCache.get(filePath);

    // Fast path: file not dirty and we checked recently → just re-evaluate time-based state
    if (cached && !cached.dirty && (now - cached.lastCheckedAt) < MIN_STAT_INTERVAL_MS) {
      const reEval = reEvalStateFromCache(cached);
      const isCompacting = reEvalCompactingFromCache(filePath);
      const scheduledWakeupAt = reEvalScheduledWakeup(cached.result.scheduledWakeupAt);
      if (reEval.state !== cached.result.state
          || reEval.needsPermission !== cached.result.needsPermission
          || isCompacting !== cached.result.isCompacting
          || scheduledWakeupAt !== cached.result.scheduledWakeupAt) {
        cached.result = { ...cached.result, state: reEval.state, needsPermission: reEval.needsPermission, isCompacting, scheduledWakeupAt, scheduledWakeupReason: scheduledWakeupAt ? cached.result.scheduledWakeupReason : undefined };
      }
      return cached.result;
    }

    // Medium path: stat the file to check mtime/size
    const stat = fs.statSync(filePath);
    const fileModifiedMs = stat.mtimeMs;
    // Shrinkage signal: jsonl transcripts are append-only, so a smaller file
    // size than last read means the file was rewritten (e.g. /clear inside a
    // --resume'd session, which keeps the same sessionId). Callers use this
    // to drop stale pre-clear state (activityFeed, currentTask, etc.).
    const transcriptTruncated = cached !== undefined && stat.size < cached.fileSize;

    // File unchanged (same mtime AND size, not dirty) → re-evaluate time-based state only
    if (cached && !cached.dirty && cached.mtimeMs === fileModifiedMs && cached.fileSize === stat.size) {
      cached.lastCheckedAt = now;
      cached.fileModifiedMs = fileModifiedMs;
      const reEval = reEvalStateFromCache(cached);
      const isCompacting = reEvalCompactingFromCache(filePath);
      const scheduledWakeupAt = reEvalScheduledWakeup(cached.result.scheduledWakeupAt);
      if (reEval.state !== cached.result.state
          || reEval.needsPermission !== cached.result.needsPermission
          || isCompacting !== cached.result.isCompacting
          || scheduledWakeupAt !== cached.result.scheduledWakeupAt) {
        cached.result = { ...cached.result, state: reEval.state, needsPermission: reEval.needsPermission, isCompacting, scheduledWakeupAt, scheduledWakeupReason: scheduledWakeupAt ? cached.result.scheduledWakeupReason : undefined };
      }
      return cached.result;
    }

    const ageSec = (now - fileModifiedMs) / 1000;

    const MAX_FEED_MESSAGES = 100;
    const MAX_CONTENT_LENGTH = 10000;

    // Read only the tail of the file — avoids reading entire multi-MB transcripts.
    // Append-only fast path: if the file merely grew since the last full parse,
    // read just the new bytes and merge, instead of re-parsing the whole 2MB window
    // every 3s poll (the dominant cost for actively-writing large transcripts).
    let tailLines: string[];
    // parsedUpToBytes: the offset through which COMPLETE lines are consumed. Seeded
    // only when the file ends on a clean newline boundary; otherwise left undefined
    // so the next poll falls back to a full read instead of starting mid-torn-line.
    let parsedUpToBytes: number | undefined;
    const incremental = (cached && !cached.dirty && !transcriptTruncated
      && cached.parsedTailLines !== undefined
      && cached.parsedUpToBytes !== undefined
      && cached.parsedUpToBytes === cached.fileSize
      && stat.size > cached.parsedUpToBytes)
      ? readFileTailIncremental(filePath, stat.size, cached.parsedTailLines, cached.parsedUpToBytes)
      : null;
    if (incremental) {
      _tailReadStatsForTest.incremental++;
      tailLines = incremental.lines;
      parsedUpToBytes = incremental.parsedUpToBytes;
    } else {
      _tailReadStatsForTest.full++;
      tailLines = readFileTail(filePath, stat.size);
      parsedUpToBytes = fileEndsWithNewline(filePath, stat.size) ? stat.size : undefined;
    }
    const last30 = tailLines.slice(-(MAX_FEED_MESSAGES * 20));

    // Find last event with type field
    let lastTypedEvent: { type: string; [key: string]: unknown } | null = null;
    for (let i = last30.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(last30[i]);
        if (parsed && typeof parsed.type === 'string') {
          lastTypedEvent = parsed as { type: string; [key: string]: unknown };
          break;
        }
      } catch {
        // skip malformed lines
      }
    }

    // Pre-pass: build tool_use_id → duration map
    const toolDurations = buildToolDurations(last30);
    // Pre-pass: build tool_use_id → result map
    const toolResults = buildToolResults(last30);

    // Build unified activityFeed (messages + tools in chronological order) and extract lastMessage
    let lastMessage: string | undefined;
    let feedTruncated = false;
    const activityFeed: ActivityItem[] = [];
    const detectedPlans: Array<{ planToolUseId: string; plan: string; timestamp?: string; planStatus: 'approved' | 'rejected' | 'pending' }> = [];
    const activeMonitors: ActiveMonitor[] = [];
    const seenMonitorIds = new Set<string>();
    // ScheduleWakeup detection (backward scan): only the MOST RECENT call counts.
    // User messages after the call do NOT invalidate — a pending wakeup survives
    // user interjections and fires regardless. The fired case is covered by
    // expiry (fireAt + grace) plus the state gate (session is working while it
    // processes the fired prompt, and the badge only renders on 'waiting').
    let scheduledWakeupAt: number | undefined;
    let scheduledWakeupReason: string | undefined;
    let scheduleWakeupChecked = false;
    // Background-task tracking. Starts found in this window, plus the tool-use-ids
    // whose <task-notification> appeared in it. Merged against the carried-forward
    // pending map after the loop — see the merge block below.
    const backgroundStarts = new Map<string, BackgroundTask>();
    const terminatedToolUseIds = new Set<string>();

    // Extract model and inputTokens from the last assistant event
    let model: string | undefined;
    let inputTokens: number | undefined;

    for (let i = last30.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(last30[i]) as {
          type?: string;
          subtype?: string;
          timestamp?: string;
          compactMetadata?: { trigger?: string; preTokens?: number };
          content?: unknown;
          attachment?: { type?: string; prompt?: string; timestamp?: string; origin?: { kind?: string }; commandMode?: string };
          message?: {
            content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
            model?: string;
            usage?: { input_tokens?: number; cache_read_input_tokens?: number };
          };
        };
        // Background-task completion. Emitted three times per task (queue-operation
        // enqueue + remove, then attachment/queued_command) — the Set dedupes.
        const notifiedToolUseId = parseTaskNotificationToolUseId(parsed);
        if (notifiedToolUseId) terminatedToolUseIds.add(notifiedToolUseId);
        if (parsed && parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
          activityFeed.unshift({
            kind: 'compact',
            content: 'Conversation compacted',
            timestamp: parsed.timestamp,
            compactMeta: {
              trigger: parsed.compactMetadata?.trigger ?? 'auto',
              preTokens: parsed.compactMetadata?.preTokens ?? 0,
            },
          });
        }
        // Away-recap ("✳ recap: …" in the TUI). A system entry, not an assistant
        // message — without this branch it never reaches the conversation feed.
        if (parsed && parsed.type === 'system' && parsed.subtype === 'away_summary') {
          const recapText = typeof parsed.content === 'string' ? stripRecapFooter(parsed.content) : '';
          if (recapText) {
            activityFeed.unshift({ kind: 'recap', content: recapText.slice(0, MAX_CONTENT_LENGTH), timestamp: parsed.timestamp });
          }
        }
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          const rawContent = parsed.message?.content;

          // Extract model and inputTokens from the last assistant event (first one we find scanning backwards)
          if (parsed.type === 'assistant' && model === undefined) {
            if (parsed.message?.model && parsed.message.model !== '<synthetic>') {
              model = parsed.message.model;
            }
            if (parsed.message?.usage) {
              const u = parsed.message.usage;
              inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            }
          }

          if (parsed.type === 'user') {
            // User message
            let text: string | undefined;
            if (typeof rawContent === 'string') {
              text = rawContent;
            } else if (Array.isArray(rawContent)) {
              const textBlock = rawContent.find((b) => b.type === 'text');
              text = textBlock?.text;
            }
            if (text) {
              activityFeed.unshift({ kind: 'message', role: 'user', ...capMessage(text), timestamp: parsed.timestamp });
            }
          } else if (parsed.type === 'assistant') {
            // Assistant message: extract text and tool_use blocks
            const contentBlocks = Array.isArray(rawContent) ? rawContent : undefined;
            let text: string | undefined;
            if (typeof rawContent === 'string') {
              text = rawContent;
            } else if (contentBlocks) {
              // Every text block, not just the first — a multi-block message would
              // otherwise silently lose everything after block 0.
              const texts = contentBlocks
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string);
              text = texts.length > 0 ? texts.join('\n\n') : undefined;
            }

            // Capture lastMessage from the most recent assistant text (first found scanning backwards)
            if (text && lastMessage === undefined) {
              lastMessage = text.slice(0, 300);
            }

            // Unshift text first (so after unshifting tools, tools appear before text in feed)
            if (text) {
              activityFeed.unshift({ kind: 'message', role: 'assistant', ...capMessage(text), timestamp: parsed.timestamp });
            }

            // Then unshift tool_use blocks (they'll appear before the text in the final order)
            if (contentBlocks) {
              for (let j = contentBlocks.length - 1; j >= 0; j--) {
                const block = contentBlocks[j];
                if (block.type === 'tool_use' && block.name) {
                  const desc = describeInput(block.input);
                  const item: ActivityItem = { kind: 'tool', toolName: block.name as string, content: desc };
                  // Capture approved plans from ExitPlanMode tool_use
                  if (block.name === 'ExitPlanMode' && block.input && typeof block.input === 'object') {
                    const planText = (block.input as Record<string, unknown>).plan;
                    const toolUseId = (block as Record<string, unknown>).id as string | undefined;
                    if (typeof planText === 'string' && planText.trim().length > 0 && toolUseId) {
                      const res = toolResults.get(toolUseId);
                      let planStatus: 'approved' | 'rejected' | 'pending';
                      if (res === undefined) {
                        planStatus = 'pending';
                      } else if (!res.isError && /approved/i.test(res.content)) {
                        planStatus = 'approved';
                      } else {
                        planStatus = 'rejected';
                      }
                      detectedPlans.push({ planToolUseId: toolUseId, plan: planText, timestamp: parsed.timestamp, planStatus });
                    }
                  }
                  // Capture in-flight Monitor tool_use (no matching tool_result yet).
                  // Reverse-chronological loop: first occurrence per id wins, superseded blocks with results are skipped.
                  if (block.name === 'Monitor') {
                    const toolUseId = (block as Record<string, unknown>).id as string | undefined;
                    if (toolUseId && !seenMonitorIds.has(toolUseId) && !toolResults.has(toolUseId)) {
                      seenMonitorIds.add(toolUseId);
                      const inp = (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {};
                      const target = (typeof inp.shellId === 'string' && inp.shellId)
                        || (typeof inp.taskId === 'string' && inp.taskId)
                        || (typeof inp.id === 'string' && inp.id)
                        || '';
                      const until = typeof inp.until === 'string' ? inp.until : undefined;
                      activeMonitors.push({ toolUseId, target: target as string, startedAt: parsed.timestamp, until });
                    }
                  }
                  // Launched background Bash. The tool_result text is the confirmation
                  // (a run_in_background input with no such result never started), and
                  // it is the only source of the shell id + output path.
                  if (block.name === 'Bash' && block.input && typeof block.input === 'object'
                      && (block.input as Record<string, unknown>).run_in_background === true) {
                    const toolUseId = (block as Record<string, unknown>).id as string | undefined;
                    const res = toolUseId ? toolResults.get(toolUseId) : undefined;
                    const m = res && !res.isError ? BACKGROUND_LAUNCH_RE.exec(res.content) : null;
                    if (toolUseId && m && !backgroundStarts.has(toolUseId)) {
                      const desc = (block.input as Record<string, unknown>).description;
                      backgroundStarts.set(toolUseId, {
                        toolUseId,
                        taskId: m[1],
                        description: typeof desc === 'string' ? desc : undefined,
                        startedAt: parsed.timestamp ?? new Date(now).toISOString(),
                        outputFile: m[2],
                      });
                    }
                  }
                  // Active ScheduleWakeup: most recent call, confirmed by a non-error
                  // tool_result, not a stop, fire time (+ grace) still ahead.
                  // delaySeconds clamped like the runtime.
                  if (block.name === 'ScheduleWakeup' && !scheduleWakeupChecked) {
                    scheduleWakeupChecked = true;
                    const inp = (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {};
                    const toolUseId = (block as Record<string, unknown>).id as string | undefined;
                    const res = toolUseId ? toolResults.get(toolUseId) : undefined;
                    if (inp.stop !== true && typeof inp.delaySeconds === 'number' && res && !res.isError && parsed.timestamp) {
                      const clampedDelay = Math.min(3600, Math.max(60, inp.delaySeconds));
                      const fireAt = Date.parse(parsed.timestamp) + clampedDelay * 1000;
                      if (Number.isFinite(fireAt) && Date.now() < fireAt + SCHEDULED_WAKEUP_GRACE_MS) {
                        scheduledWakeupAt = fireAt;
                        scheduledWakeupReason = typeof inp.reason === 'string' ? inp.reason : undefined;
                      }
                    }
                  }
                  if (block.input && typeof block.input === 'object') {
                    const inp = block.input as Record<string, unknown>;
                    if (block.name === 'Edit') {
                      if (typeof inp.old_string === 'string') {
                        item.oldString = inp.old_string.slice(0, MAX_CONTENT_LENGTH);
                        if (inp.old_string.length > MAX_CONTENT_LENGTH) item.oldStringTruncated = true;
                      }
                      if (typeof inp.new_string === 'string') {
                        item.newString = inp.new_string.slice(0, MAX_CONTENT_LENGTH);
                        if (inp.new_string.length > MAX_CONTENT_LENGTH) item.newStringTruncated = true;
                      }
                    } else if (block.name === 'Write') {
                      if (typeof inp.content === 'string') {
                        item.oldString = '';
                        item.newString = inp.content.slice(0, MAX_CONTENT_LENGTH);
                        if (inp.content.length > MAX_CONTENT_LENGTH) item.newStringTruncated = true;
                      }
                    }
                    // Store trimmed input JSON (truncate large string values)
                    const trimmed: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(inp)) {
                      if (typeof v === 'string' && v.length > 500) {
                        trimmed[k] = v.slice(0, 500) + '…';
                      } else {
                        trimmed[k] = v;
                      }
                    }
                    item.inputJson = JSON.stringify(trimmed, null, 2);
                  }
                  // Compute duration and result from pre-pass maps
                  const blockId = (block as Record<string, unknown>).id as string | undefined;
                  if (blockId) {
                    const dur = toolDurations.get(blockId);
                    if (dur !== undefined) item.durationMs = dur;
                    const res = toolResults.get(blockId);
                    if (res !== undefined && res.content.length > 0) {
                      item.resultJson = res.content;
                      if (res.isError) item.isError = true;
                    }
                  }
                  if (parsed.timestamp) item.timestamp = parsed.timestamp;
                  activityFeed.unshift(item);
                }
              }

              // Extract thinking blocks — skip redacted and empty ones
              for (let j = 0; j < contentBlocks.length; j++) {
                const block = contentBlocks[j];
                if (block.type === 'thinking') {
                  const thinkingText = typeof (block as Record<string, unknown>).thinking === 'string' ? (block as Record<string, unknown>).thinking as string : '';
                  if (thinkingText.trim().length > 0) {
                    activityFeed.unshift({
                      kind: 'thinking',
                      content: thinkingText.slice(0, MAX_CONTENT_LENGTH),
                      timestamp: parsed.timestamp,
                    });
                  }
                }
              }
            }
          }

          const messageCount = activityFeed.filter(x => x.kind === 'message').length;
          if (messageCount >= MAX_FEED_MESSAGES) { feedTruncated = true; break; }
        }

        // Queued (busy-typed) user messages are recorded only as attachment/queued_command,
        // never as a `user` record. Surface them as user bubbles so they aren't "eaten".
        if (parsed && parsed.type === 'attachment'
          && parsed.attachment?.type === 'queued_command'
          && parsed.attachment.origin?.kind === 'human') {
          const prompt = parsed.attachment.prompt;
          if (typeof prompt === 'string' && prompt.trim().length > 0) {
            activityFeed.unshift({
              kind: 'message',
              role: 'user',
              content: prompt.slice(0, MAX_CONTENT_LENGTH),
              timestamp: parsed.attachment.timestamp ?? parsed.timestamp,
            });
            const messageCount = activityFeed.filter(x => x.kind === 'message').length;
            if (messageCount >= MAX_FEED_MESSAGES) { feedTruncated = true; break; }
          }
        }
      } catch {
        // skip
      }
    }

    // Incrementally scan for compact_boundary events (avoids re-reading entire file)
    const { compactCount, isCompacting } = detectCompactionIncremental(filePath, stat.size);

    const lastActivity = new Date(fileModifiedMs).toISOString();

    // Detect "DONE" command: scan back for the most recent user message that is NOT a tool_result

    // Detect permission mode from the most recent source:
    // 1. Dedicated `type: "permission-mode"` entries (written at session start)
    // 2. `permissionMode` field on `type: "user"` messages (written with every user message)
    // Scan backwards — first match wins (most recent).
    let permissionMode: string | undefined;
    for (let i = last30.length - 1; i >= 0; i--) {
      try {
        const p = JSON.parse(last30[i]) as { type?: string; permissionMode?: string };
        if (p.permissionMode) {
          permissionMode = p.permissionMode;
          break;
        }
      } catch { /* skip */ }
    }

    // Determine state + stateHint (hint is used for time-only re-evaluation without I/O)
    let state: WorkerState;
    let stateHint: TranscriptCache['stateHint'] = 'none';
    let needsPermission: boolean | undefined;
    let permissionPromptText: string | undefined;
    let pendingQuestion: PendingQuestionSet | undefined;
    if (lastTypedEvent?.type === 'assistant') {
      const lastContent = lastTypedEvent.message as { content?: unknown } | undefined;
      const contentArr = Array.isArray(lastContent?.content) ? lastContent!.content as Array<{ type?: string; name?: string; input?: unknown }> : [];
      const lastBlock = contentArr.length > 0 ? contentArr[contentArr.length - 1] : undefined;
      const endsWithToolUse = lastBlock?.type === 'tool_use';

      if (endsWithToolUse) {
        const toolName = lastBlock?.name ?? '';
        // MCP tools (mcp__*) can run for minutes — don't flag as permission prompt
        const isMcpTool = toolName.startsWith('mcp__');
        // AskUserQuestion is an interactive question — shown as its own UI, not a permission prompt
        const isAskUser = toolName === 'AskUserQuestion';
        // Tools that legitimately run for a long time — don't flag as permission prompt from transcript.
        // The screen-based permissionChecker handles real prompts for these.
        const LONG_RUNNING_TOOLS = new Set(['Bash', 'execute_command', 'RunCommand', 'Agent', 'WebFetch', 'WebSearch']);
        const isLongRunning = LONG_RUNNING_TOOLS.has(toolName);

        if (isAskUser) {
          // Extract ALL questions from tool input
          const toolInput = lastBlock!.input as { questions?: Array<{ question?: string; header?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string; preview?: string }> }> } | undefined;
          const rawQuestions = toolInput?.questions ?? [];
          const parsedQuestions: PendingQuestion[] = rawQuestions
            .filter(q => q.question)
            .map(q => ({
              question: q.question!,
              header: q.header,
              multiSelect: q.multiSelect ?? false,
              options: (q.options ?? []).map(o => ({
                label: o.label ?? '',
                description: o.description,
                preview: o.preview,
              })).filter(o => o.label),
            }));
          if (parsedQuestions.length > 0) {
            pendingQuestion = { questions: parsedQuestions };
          }
          stateHint = 'ask_user_question';
          state = ageSec < 5 ? 'working' : 'waiting';
        } else {
          stateHint = (isMcpTool || isLongRunning) ? 'tool_result' : 'tool_use';
          // Always compute permissionPromptText when a tool_use is pending, so it's
          // available in the cache when reEvalStateFromCache later sets needsPermission.
          // (The full parse may run when ageSec < 5, but re-eval fires when ageSec > 8.)
          if (toolName) {
            const toolInput = lastBlock!.input as Record<string, unknown> | undefined;
            const desc = toolInput ? describeInput(toolInput) : '';
            permissionPromptText = desc ? `${toolName}: ${desc}` : toolName;
          }
          if (isMcpTool || isLongRunning) {
            // MCP tools and known long-running tools — show working until idle, never flag as permission.
            // Real permission prompts are detected by the screen-based permissionChecker.
            state = ageSec < 8 ? 'working' : 'waiting';
          } else if (ageSec < 5) {
            state = 'working';
          } else {
            // Collapse middle band: go directly to waiting past 5s. needsPermission still
            // gates at the 8s threshold per existing heuristic.
            state = 'waiting';
            if (ageSec > 8) {
              needsPermission = permissionMode !== 'bypassPermissions' ? true : undefined;
            }
          }
        }
      } else {
        stateHint = 'assistant_text';
        state = ageSec < 5 ? 'working' : 'waiting';
      }
    } else if (lastTypedEvent?.type === 'user') {
      const userContent = lastTypedEvent.message as { content?: unknown } | undefined;
      const userContentArr = Array.isArray(userContent?.content) ? userContent!.content as Array<{ type?: string }> : [];
      const isToolResult = userContentArr.length > 0 && userContentArr[0]?.type === 'tool_result';

      // Detect "[Request interrupted by user]" — session is waiting for new input
      const firstBlock = userContentArr[0] as { type?: string; text?: string } | undefined;
      const isInterrupted = !isToolResult && firstBlock?.type === 'text'
        && typeof firstBlock.text === 'string'
        && firstBlock.text.startsWith('[Request interrupted by user');

      if (isInterrupted) {
        stateHint = 'none';
        state = 'waiting';
      } else if (isToolResult) {
        stateHint = 'tool_result';
        state = ageSec < 8 ? 'working' : 'waiting';
      } else {
        stateHint = 'user_input';
        state = ageSec < 8 ? 'working' : 'waiting';
      }
    } else {
      stateHint = 'none';
      state = 'waiting';
    }

    // Evidence-based 'thinking': Claude just emitted a thinking block (within 6s).
    // Without this override, assistant messages containing thinking+text get assistant_text
    // hint and would fall through to working/waiting. Only override when ageSec is fresh.
    if ((state === 'working' || state === 'waiting') && ageSec < 6 && activityFeed[0]?.kind === 'thinking') {
      state = 'thinking';
    }

    // Sticky merge for background tasks: carry the previous pending map forward,
    // add starts seen in this window, drop everything the transcript reported as
    // finished, then TTL the rest. A bounded scan cannot rebuild this — a command
    // running for hours has its launch lines far outside the tail window.
    const pendingBackgroundTasks = new Map<string, BackgroundTask>(
      transcriptTruncated ? [] : (cached?.pendingBackgroundTasks ?? []),
    );
    for (const [id, task] of backgroundStarts) {
      if (!pendingBackgroundTasks.has(id)) pendingBackgroundTasks.set(id, task);
    }
    for (const id of terminatedToolUseIds) pendingBackgroundTasks.delete(id);
    for (const [id, task] of pendingBackgroundTasks) {
      const startedMs = task.startedAt ? Date.parse(task.startedAt) : NaN;
      if (!Number.isFinite(startedMs) || now - startedMs > BACKGROUND_TASK_TTL_MS) {
        pendingBackgroundTasks.delete(id);
        continue;
      }
      // Liveness hint: when the command last wrote. Mutated in place so the object
      // identity stays stable across parses while the mtime is unchanged.
      if (task.outputFile) {
        try {
          task.lastOutputAt = fs.statSync(task.outputFile).mtimeMs;
        } catch {
          // output file gone — keep the task, the notification is still authoritative
        }
      }
    }
    const backgroundTasks = Array.from(pendingBackgroundTasks.values());

    const scanSegments = gatherScanSegments(last30);
    const jiraKeys = extractJiraKeys(scanSegments.user, getJiraProjectRegex());
    const prRefs = extractPrRefs(scanSegments.wide);
    const skillsUsed = unionSkillNames(extractSkillsUsed(scanSegments.user), extractSkillToolUses(last30));

    const result = {
      state,
      lastActivity,
      lastMessage,
      activityFeed: activityFeed.length > 0 ? activityFeed : undefined,
      feedTruncated: feedTruncated || undefined,
      model,
      inputTokens,
      compactCount: compactCount > 0 ? compactCount : undefined,
      isCompacting: isCompacting || undefined,
      needsPermission: needsPermission || undefined,
      permissionPromptText,
      permissionMode,
      pendingQuestion,
      transcriptTruncated: transcriptTruncated || undefined,
      detectedPlans: detectedPlans.length > 0 ? detectedPlans : undefined,
      activeMonitors: activeMonitors.length > 0 ? activeMonitors : undefined,
      scheduledWakeupAt,
      scheduledWakeupReason,
      backgroundTasks: backgroundTasks.length > 0 ? backgroundTasks : undefined,
      jiraKeys: jiraKeys.length > 0 ? jiraKeys : undefined,
      prRefs: prRefs.length > 0 ? prRefs : undefined,
      skillsUsed: skillsUsed.length > 0 ? skillsUsed : undefined,
    };
    transcriptCache.set(filePath, { mtimeMs: fileModifiedMs, fileSize: stat.size, fileModifiedMs, lastCheckedAt: now, stateHint, result, dirty: false, parsedTailLines: tailLines, parsedUpToBytes, pendingBackgroundTasks });
    evictTranscriptCache(now);
    return result;
  } catch {
    return {
      state: 'closed' as WorkerState,
      lastActivity: new Date().toISOString(),
    };
  }
}

function readCodexTranscriptState(filePath: string): {
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  needsPermission?: boolean;
  permissionPromptText?: string;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
  jiraKeys?: string[];
  prRefs?: string[];
} {
  try {
    const now = Date.now();
    const cached = transcriptCache.get(filePath);
    if (cached && !cached.dirty && (now - cached.lastCheckedAt) < MIN_STAT_INTERVAL_MS) {
      const reEval = reEvalStateFromCache(cached);
      if (reEval.state !== cached.result.state || reEval.needsPermission !== cached.result.needsPermission) {
        cached.result = { ...cached.result, state: reEval.state, needsPermission: reEval.needsPermission };
      }
      return cached.result;
    }

    const stat = fs.statSync(filePath);
    const fileModifiedMs = stat.mtimeMs;
    if (cached && !cached.dirty && cached.mtimeMs === fileModifiedMs && cached.fileSize === stat.size) {
      cached.lastCheckedAt = now;
      cached.fileModifiedMs = fileModifiedMs;
      const reEval = reEvalStateFromCache(cached);
      if (reEval.state !== cached.result.state || reEval.needsPermission !== cached.result.needsPermission) {
        cached.result = { ...cached.result, state: reEval.state, needsPermission: reEval.needsPermission };
      }
      return cached.result;
    }

    const ageSec = (now - fileModifiedMs) / 1000;
    const MAX_FEED_MESSAGES = 100;
    const MAX_CONTENT_LENGTH = 10000;
    const tailLines = readFileTail(filePath, stat.size);
    const last30 = tailLines.slice(-(MAX_FEED_MESSAGES * 20));

    let lastMessage: string | undefined;
    const activityFeed: ActivityItem[] = [];
    let model: string | undefined;
    let inputTokens: number | undefined;
    let stateHint: TranscriptCache['stateHint'] = 'none';
    let state: WorkerState = 'waiting';

    const callDurations = new Map<string, number>();
    for (const line of last30) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          payload?: {
            type?: string;
            call_id?: string;
            duration?: { secs?: number; nanos?: number };
            info?: { last_token_usage?: { input_tokens?: number; cached_input_tokens?: number } };
          };
        };
        if (parsed.type === 'event_msg' && parsed.payload?.type === 'exec_command_end' && parsed.payload.call_id) {
          const secs = parsed.payload.duration?.secs ?? 0;
          const nanos = parsed.payload.duration?.nanos ?? 0;
          callDurations.set(parsed.payload.call_id, Math.round((secs * 1000) + (nanos / 1_000_000)));
        }
        if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count' && inputTokens === undefined) {
          const usage = parsed.payload.info?.last_token_usage;
          if (usage) inputTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
        }
        if (parsed.type === 'session_meta' && model === undefined) {
          const payload = parsed.payload as { model?: string } | undefined;
          model = payload?.model;
        }
      } catch {
        // skip
      }
    }

    for (let i = last30.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(last30[i]) as {
          timestamp?: string;
          type?: string;
          payload?: {
            type?: string;
            role?: string;
            phase?: string;
            message?: string;
            name?: string;
            arguments?: string;
            call_id?: string;
            output?: string;
          };
        };

        if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
          const role = parsed.payload.role;
          if (role !== 'user' && role !== 'assistant') continue;
          const blocks = Array.isArray((parsed.payload as { content?: Array<{ type?: string; text?: string }> }).content)
            ? ((parsed.payload as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
            : [];
          const text = blocks
            .map(block => block.text ?? '')
            .join('\n')
            .trim();
          if (!text) continue;
          if (role === 'assistant' && lastMessage === undefined) lastMessage = text.slice(0, 300);
          activityFeed.unshift({
            kind: 'message',
            role: role as 'user' | 'assistant',
            ...capMessage(text),
            timestamp: parsed.timestamp,
          });
        } else if (parsed.type === 'response_item' && parsed.payload?.type === 'function_call' && parsed.payload.name) {
          const item: ActivityItem = {
            kind: 'tool',
            toolName: parsed.payload.name,
            content: parsed.payload.name,
            timestamp: parsed.timestamp,
          };
          if (parsed.payload.arguments) {
            item.inputJson = parsed.payload.arguments;
            try {
              const args = JSON.parse(parsed.payload.arguments) as Record<string, unknown>;
              item.content = describeInput(args);
            } catch {
              item.content = parsed.payload.arguments.slice(0, 300);
            }
          }
          const durationMs = parsed.payload.call_id ? callDurations.get(parsed.payload.call_id) : undefined;
          if (durationMs !== undefined) item.durationMs = durationMs;
          activityFeed.unshift(item);
        } else if (parsed.type === 'event_msg' && parsed.payload?.type === 'agent_message' && parsed.payload.message && lastMessage === undefined) {
          lastMessage = parsed.payload.message.slice(0, 300);
        }

        const messageCount = activityFeed.filter(item => item.kind === 'message').length;
        if (messageCount >= MAX_FEED_MESSAGES) break;
      } catch {
        // skip
      }
    }

    for (let i = last30.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(last30[i]) as {
          type?: string;
          payload?: { type?: string; role?: string; phase?: string };
        };
        if (parsed.type === 'response_item' && parsed.payload?.type === 'function_call') {
          stateHint = 'tool_use';
          state = ageSec < 8 ? 'working' : 'waiting';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'reasoning') {
          stateHint = 'codex_reasoning';
          state = ageSec < 6 ? 'thinking' : 'working';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'function_call_output') {
          stateHint = 'tool_result';
          state = ageSec < 8 ? 'working' : 'waiting';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
          if (parsed.payload.role === 'user') {
            stateHint = 'user_input';
            state = ageSec < 8 ? 'working' : 'waiting';
          } else if (parsed.payload.role === 'assistant') {
            stateHint = 'assistant_text';
            state = 'waiting';
          }
          break;
        }
        if (parsed.type === 'event_msg' && parsed.payload?.type === 'task_complete') {
          stateHint = 'assistant_text';
          state = 'waiting';
          break;
        }
      } catch {
        // skip
      }
    }

    const codexSegments = gatherScanSegments(last30);
    const jiraKeys = extractJiraKeys(codexSegments.user, getJiraProjectRegex());
    const prRefs = extractPrRefs(codexSegments.wide);

    const result = {
      state,
      lastActivity: new Date(fileModifiedMs).toISOString(),
      lastMessage,
      activityFeed: activityFeed.length > 0 ? activityFeed : undefined,
      model,
      inputTokens,
      jiraKeys: jiraKeys.length > 0 ? jiraKeys : undefined,
      prRefs: prRefs.length > 0 ? prRefs : undefined,
    };
    transcriptCache.set(filePath, { mtimeMs: fileModifiedMs, fileSize: stat.size, fileModifiedMs, lastCheckedAt: now, stateHint, result, dirty: false });
    evictTranscriptCache(now);
    return result;
  } catch {
    return {
      state: 'closed',
      lastActivity: new Date().toISOString(),
    };
  }
}

/** filePath → resolved slug. `slug` is stamped on the transcript once and never
 *  changes for that file, so a hit is permanent. Misses record the size scanned
 *  and the time, because a slug-less transcript is the case that would otherwise
 *  re-read the whole file forever. */
const slugCache = new Map<string, { slug: string | undefined; scannedSize: number; scannedAt: number }>();
/** How long a "no slug in this file" verdict stands before the growing tail is
 *  re-checked. The slug lands within the first few hundred records or not at all. */
const SLUG_MISS_TTL_MS = 60_000;

/** Read the session slug out of a transcript.
 *
 *  PERFORMANCE: this reads and JSON.parses the file line by line until it finds a
 *  `slug` field, which in a real transcript is several hundred records in (line
 *  ~590 of an 8.6MB file is typical). It is called from BOTH `addOrUpdate` (every
 *  chokidar event) and `refreshTranscript` (every 3s poll), so uncached it was
 *  4% of server CPU — synchronous, on the thread that also carries PTY bytes.
 *  Cached, the scan runs at most once per file. */
export function readSlug(filePath: string): string | undefined {
  if (isCodexTranscript(filePath)) return undefined;

  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return undefined;
  }

  const cached = slugCache.get(filePath);
  if (cached) {
    // A found slug is final.
    if (cached.slug !== undefined) return cached.slug;
    // Shrinkage means the file was rewritten (/clear in a --resume'd session) —
    // the old verdict is about a file that no longer exists. Otherwise hold the
    // miss until it goes stale AND the file has actually grown.
    if (size >= cached.scannedSize
        && (size === cached.scannedSize || Date.now() - cached.scannedAt < SLUG_MISS_TTL_MS)) {
      return undefined;
    }
  }

  let slug: string | undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      // Cheap reject before the parse: the overwhelming majority of records have
      // no slug field at all, and JSON.parse of a 100KB assistant message is not free.
      if (line.indexOf('"slug"') < 0) continue;
      try {
        const parsed = JSON.parse(line) as { slug?: string };
        if (parsed.slug && typeof parsed.slug === 'string') {
          slug = parsed.slug;
          break;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  slugCache.set(filePath, { slug, scannedSize: size, scannedAt: Date.now() });
  return slug;
}

export function readProposedName(sessionId: string, transcriptPath: string): string | undefined {
  const cached = proposedNameCache.get(sessionId);
  if (cached !== undefined) return cached;

  // Strategy 0: authoritative customTitle header in transcript (set at spawn
  // via --name). Strip ___OVR:/___BRG: markers. This is the most reliable
  // source — survives PID file deletion on session close.
  if (!isCodexTranscript(transcriptPath)) {
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
        const firstChunk = buf.toString('utf-8', 0, bytesRead);
        const firstLine = firstChunk.split('\n')[0];
        if (firstLine && firstLine.trim()) {
          try {
            const parsed = JSON.parse(firstLine) as { type?: string; customTitle?: string };
            if (parsed.type === 'custom-title' && typeof parsed.customTitle === 'string') {
              let title = parsed.customTitle;
              if (title.includes('___OVR:')) title = title.split('___OVR:')[0];
              if (title.includes('___BRG:')) title = title.split('___BRG:')[0];
              title = title.trim();
              if (title.length > 0 && !title.startsWith('<local-command-caveat')) {
                proposedNameCache.set(sessionId, title);
                return title;
              }
            }
          } catch { /* not valid JSON — fall through */ }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* transcript unreadable — fall through */ }
  }

  if (isCodexTranscript(transcriptPath)) {
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      let content = '';
      try {
        const stat = fs.fstatSync(fd);
        const readSize = Math.min(stat.size, 64 * 1024);
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, 0);
        content = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            payload?: { type?: string; role?: string; content?: Array<{ text?: string }> };
          };
          if (parsed.type !== 'response_item' || parsed.payload?.type !== 'message' || parsed.payload.role !== 'user') continue;
          const text = (parsed.payload.content ?? []).map(block => block.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
          if (!text || text.startsWith('<environment_context>')) continue;
          const result = text.slice(0, 50);
          proposedNameCache.set(sessionId, result);
          return result;
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  // Strategy 1: first meaningful task subject from ~/.claude/tasks/{sessionId}/
  const tasksDir = path.join(os.homedir(), '.claude', 'tasks', sessionId);
  try {
    if (fs.existsSync(tasksDir)) {
      // Read task files 1.json, 2.json, ... until we find a non-deleted one with a subject
      for (let i = 1; i <= 10; i++) {
        const taskPath = path.join(tasksDir, `${i}.json`);
        if (!fs.existsSync(taskPath)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8')) as {
            subject?: string;
            status?: string;
          };
          if (task.subject && task.status !== 'deleted') {
            // Truncate to 50 chars
            const result = task.subject.slice(0, 50);
            proposedNameCache.set(sessionId, result);
            return result;
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // ignore
  }

  // Strategy 2: first user message from transcript (only read first 64KB — the first message is near the top)
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    let content: string;
    try {
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(stat.size, 64 * 1024);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      content = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        };
        if (parsed.type === 'user') {
          const content = parsed.message?.content;
          let text: string | undefined;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const block = content.find((b) => b.type === 'text');
            text = block?.text;
          }
          if (text) {
            // Clean up and truncate
            const cleaned = text.replace(/\s+/g, ' ').trim();
            if (cleaned.length > 5) {
              const result = cleaned.slice(0, 50);
              proposedNameCache.set(sessionId, result);
              return result;
            }
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

export function readSubagents(cwd: string, sessionId: string, transcriptPath?: string | null): Subagent[] {
  if (cwd.replace(/\\/g, '/').includes('/.codex/')) return [];
  // Prefer deriving the path from the already-resolved transcriptPath (avoids cwdToSlug
  // stripping the leading dash that Claude Code uses in project directory names).
  const subagentsDir = transcriptPath
    ? path.join(path.dirname(transcriptPath), sessionId, 'subagents')
    : path.join(os.homedir(), '.claude', 'projects', cwdToSlug(cwd), sessionId, 'subagents');

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const subagents: Subagent[] = [];

  try {
    if (!fs.existsSync(subagentsDir)) {
      return subagents;
    }

    const dirStat = fs.statSync(subagentsDir);
    const dirMtime = dirStat.mtimeMs;
    let agentIds: string[];
    const dirCached = subagentsDirCache.get(subagentsDir);
    if (dirCached && dirCached.mtimeMs === dirMtime) {
      agentIds = dirCached.agentIds;
    } else {
      const entries = fs.readdirSync(subagentsDir);
      const idSet = new Set<string>();
      for (const entry of entries) {
        if (entry.endsWith('.meta.json')) idSet.add(entry.replace(/\.meta\.json$/, ''));
        else if (entry.endsWith('.jsonl')) idSet.add(entry.replace(/\.jsonl$/, ''));
      }
      agentIds = [...idSet];
      subagentsDirCache.set(subagentsDir, { mtimeMs: dirMtime, agentIds });
    }

    for (const agentId of agentIds) {
      try {
        const metaPath = path.join(subagentsDir, `${agentId}.meta.json`);
        let agentType = 'unknown';
        let description = '';

        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
            agentType?: string;
            description?: string;
          };
          agentType = meta.agentType ?? 'unknown';
          description = meta.description ?? '';
        }

        const transcriptFile = path.join(subagentsDir, `${agentId}.jsonl`);
        let state: WorkerState = 'closed';
        let lastActivity = new Date().toISOString();
        let activityFeed: import('../types.js').ActivityItem[] | undefined;
        let model: string | undefined;

        if (fs.existsSync(transcriptFile)) {
          // Skip expensive transcript read for old subagents (>10min)
          try {
            const tStat = fs.statSync(transcriptFile);
            if (Date.now() - tStat.mtimeMs > TEN_MINUTES_MS) {
              continue; // will be filtered out anyway
            }
          } catch { /* proceed to read */ }
          const result = readTranscriptState(transcriptFile);
          state = result.state;
          lastActivity = result.lastActivity;
          activityFeed = result.activityFeed;
          model = result.model;
        }

        subagents.push({
          agentId,
          agentType,
          description,
          state,
          lastActivity,
          activityFeed,
          model,
        });
      } catch {
        // skip this subagent
      }
    }
  } catch {
    // ignore directory read errors
  }

  const now = Date.now();
  return subagents.filter((s) => {
    if (s.state === 'working' || s.state === 'thinking') return true;
    const age = now - new Date(s.lastActivity).getTime();
    return age < TEN_MINUTES_MS;
  });
}

/**
 * Read activity items from a transcript JSONL that occurred BEFORE a given timestamp.
 * Used by the search tab to load earlier conversation context when the feed is trimmed.
 */
export function readActivityBefore(filePath: string, beforeTimestamp: string, limit = 50): { items: ActivityItem[]; hasMore: boolean } {
  let content: string;
  try {
    // Cap read at 32MB to avoid stalling on huge transcripts
    const stat = fs.statSync(filePath);
    const MAX_BYTES = 32 * 1024 * 1024;
    if (stat.size > MAX_BYTES) {
      const buf = Buffer.alloc(MAX_BYTES);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, MAX_BYTES, 0); // read from start
      fs.closeSync(fd);
      content = buf.toString('utf8');
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
  } catch { return { items: [], hasMore: false }; }

  const allLines = content.split('\n').filter(l => l.trim());

  // Collect lines with timestamp < beforeTimestamp (forward scan, stop at first match)
  const beforeLines: string[] = [];
  for (const line of allLines) {
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      if (parsed.timestamp && parsed.timestamp >= beforeTimestamp) break;
    } catch { /* keep line, can't parse */ }
    beforeLines.push(line);
  }

  if (beforeLines.length === 0) return { items: [], hasMore: false };

  // Parse the tail of beforeLines (reverse scan, same logic as readTranscriptState)
  const windowSize = limit * 20;
  const window = beforeLines.slice(-windowSize);
  const hasMoreBefore = beforeLines.length > windowSize;
  const MAX_CONTENT = 10000;
  const activityFeed: ActivityItem[] = [];
  let messageCount = 0;
  let hitLimit = false;

  for (let i = window.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(window[i]) as {
        type?: string;
        subtype?: string;
        content?: unknown;
        timestamp?: string;
        attachment?: { type?: string; prompt?: string; timestamp?: string; origin?: { kind?: string } };
        message?: {
          content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
        };
      };

      if (parsed.type === 'system' && parsed.subtype === 'away_summary') {
        const recapText = typeof parsed.content === 'string' ? stripRecapFooter(parsed.content) : '';
        if (recapText) {
          activityFeed.unshift({ kind: 'recap', content: recapText.slice(0, MAX_CONTENT), timestamp: parsed.timestamp });
        }
      } else if (parsed.type === 'attachment'
        && parsed.attachment?.type === 'queued_command'
        && parsed.attachment.origin?.kind === 'human') {
        const prompt = parsed.attachment.prompt;
        if (typeof prompt === 'string' && prompt.trim().length > 0) {
          activityFeed.unshift({ kind: 'message', role: 'user', content: prompt.slice(0, MAX_CONTENT), timestamp: parsed.attachment.timestamp ?? parsed.timestamp });
          messageCount++;
        }
      } else if (parsed.type === 'user') {
        const rawContent = parsed.message?.content;
        let text: string | undefined;
        if (typeof rawContent === 'string') text = rawContent;
        else if (Array.isArray(rawContent)) {
          const tb = rawContent.find(b => b.type === 'text');
          text = (tb as { text?: string })?.text;
        }
        if (text) {
          activityFeed.unshift({ kind: 'message', role: 'user', content: text.slice(0, MAX_CONTENT), timestamp: parsed.timestamp });
          messageCount++;
        }
      } else if (parsed.type === 'assistant') {
        const rawContent = parsed.message?.content;
        const contentBlocks = Array.isArray(rawContent) ? rawContent as Array<{ type?: string; text?: string; name?: string; input?: unknown }> : undefined;
        let text: string | undefined;
        if (typeof rawContent === 'string') text = rawContent;
        else if (contentBlocks) {
          const tb = contentBlocks.find(b => b.type === 'text');
          text = (tb as { text?: string })?.text;
        }
        if (text) {
          activityFeed.unshift({ kind: 'message', role: 'assistant', content: text.slice(0, MAX_CONTENT), timestamp: parsed.timestamp });
          messageCount++;
        }
        if (contentBlocks) {
          for (let j = contentBlocks.length - 1; j >= 0; j--) {
            const block = contentBlocks[j] as { type?: string; name?: string; input?: unknown };
            if (block.type === 'tool_use' && block.name) {
              activityFeed.unshift({ kind: 'tool', toolName: block.name as string, content: block.name as string, timestamp: parsed.timestamp });
            }
          }
        }
      }

      if (messageCount >= limit) { hitLimit = true; break; }
    } catch { /* skip malformed */ }
  }

  return { items: activityFeed, hasMore: hasMoreBefore || hitLimit };
}
