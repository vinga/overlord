import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WorkerState, Subagent, ActivityItem, PendingQuestion, PendingQuestionSet } from '../types.js';

interface TranscriptCache {
  mtimeMs: number;
  fileSize: number;
  fileModifiedMs: number; // raw mtime for age calculation
  lastCheckedAt: number; // wall-clock time of last stat() call
  /** Which state-determination branch to use when re-evaluating from time alone */
  stateHint: 'tool_use' | 'ask_user_question' | 'assistant_text' | 'tool_result' | 'user_input' | 'none' | 'codex_reasoning';
  result: ReturnType<typeof readTranscriptState>;
  dirty: boolean; // set by markDirty() when chokidar fires
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
 * Re-evaluate the time-dependent state from a cached stateHint without any file I/O.
 * Returns null if the state hasn't changed (caller can skip broadcasting).
 */
function reEvalStateFromCache(cached: TranscriptCache): { state: WorkerState; needsPermission?: boolean } {
  const ageSec = (Date.now() - cached.fileModifiedMs) / 1000;
  // After 2 minutes of no file updates, assume the session/subagent is stale
  // But still check for pending tool_use → permission prompt
  if (ageSec > 120) {
    if (cached.stateHint === 'tool_use') return { state: 'waiting', needsPermission: true };
    // ask_user_question stays waiting without permission flag
    return { state: 'waiting' };
  }
  switch (cached.stateHint) {
    case 'tool_use': {
      const state: WorkerState = ageSec < 5 ? 'working' : ageSec > 8 ? 'waiting' : 'thinking';
      // Tool pending >8s with no result → likely permission prompt
      const needsPermission = ageSec > 8 ? true : undefined;
      return { state, needsPermission };
    }
    case 'ask_user_question': {
      // AskUserQuestion — never a permission prompt, just goes to waiting
      const state: WorkerState = ageSec < 5 ? 'working' : 'waiting';
      return { state };
    }
    case 'assistant_text': return { state: ageSec < 3 ? 'working' : 'waiting' };
    case 'tool_result':  return { state: ageSec < 8 ? 'working' : 'thinking' };
    case 'user_input':   return { state: ageSec < 8 ? 'working' : 'thinking' };
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

export function cwdToSlug(cwd: string): string {
  // Replace \, :, / with -
  const slug = cwd.replace(/[\\:/]/g, '-');
  // Strip leading dashes
  return slug.replace(/^-+/, '');
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
  return null;
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
  return null;
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

/**
 * Incrementally scan for compact_boundary events.
 * Only reads new content since the last scan, caching the count.
 */
function detectCompactionIncremental(filePath: string, fileSize: number): { compactCount: number; isCompacting: boolean } {
  const cached = compactCountCache.get(filePath);
  const now = Date.now();

  let compactCount = cached?.compactCount ?? 0;
  let lastCompactTimestamp = cached?.lastCompactTimestamp;
  const scanFrom = cached?.fileSize ?? 0;

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

  const isCompacting = lastCompactTimestamp !== undefined && now - lastCompactTimestamp < 5000;
  return { compactCount, isCompacting };
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const val = obj.file_path ?? obj.description ?? obj.command ?? obj.pattern ?? obj.prompt ?? obj.query ?? '';
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

function detectLastUserIsDone(last30: string[]): boolean {
  for (let i = last30.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(last30[i]) as {
        type?: string;
        message?: { content?: unknown };
      };
      if (parsed.type !== 'user') continue;
      const rawContent = parsed.message?.content;
      const contentArr = Array.isArray(rawContent) ? rawContent as Array<{ type?: string; text?: string }> : null;
      // Skip if this is purely tool_results (system-provided, not human)
      const isToolResult = contentArr !== null && contentArr.length > 0 && contentArr[0]?.type === 'tool_result';
      if (isToolResult) continue;
      // Extract text
      let text: string | undefined;
      if (typeof rawContent === 'string') {
        text = rawContent;
      } else if (contentArr) {
        const textBlock = contentArr.find((b) => b.type === 'text');
        text = textBlock?.text;
      }
      if (text !== undefined) {
        return text.trim().toLowerCase() === 'done';
      }
      break;
    } catch {
      // skip malformed lines
    }
  }
  return false;
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
  lastUserIsDone?: boolean;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
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
      if (reEval.state !== cached.result.state || reEval.needsPermission !== cached.result.needsPermission) {
        cached.result = { ...cached.result, state: reEval.state, needsPermission: reEval.needsPermission };
      }
      return cached.result;
    }

    // Medium path: stat the file to check mtime/size
    const stat = fs.statSync(filePath);
    const fileModifiedMs = stat.mtimeMs;

    // File unchanged (same mtime AND size, not dirty) → re-evaluate time-based state only
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

    // Read only the tail of the file — avoids reading entire multi-MB transcripts
    const tailLines = readFileTail(filePath, stat.size);
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

    // Build unified activityFeed (messages + tools in chronological order) and extract lastMessage
    let lastMessage: string | undefined;
    const activityFeed: ActivityItem[] = [];

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
          message?: {
            content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
            model?: string;
            usage?: { input_tokens?: number; cache_read_input_tokens?: number };
          };
        };
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
              activityFeed.unshift({ kind: 'message', role: 'user', content: text.slice(0, MAX_CONTENT_LENGTH), timestamp: parsed.timestamp });
            }
          } else if (parsed.type === 'assistant') {
            // Assistant message: extract text and tool_use blocks
            const contentBlocks = Array.isArray(rawContent) ? rawContent : undefined;
            let text: string | undefined;
            if (typeof rawContent === 'string') {
              text = rawContent;
            } else if (contentBlocks) {
              const textBlock = contentBlocks.find((b) => b.type === 'text');
              text = textBlock?.text;
            }

            // Capture lastMessage from the most recent assistant text (first found scanning backwards)
            if (text && lastMessage === undefined) {
              lastMessage = text.slice(0, 300);
            }

            // Unshift text first (so after unshifting tools, tools appear before text in feed)
            if (text) {
              activityFeed.unshift({ kind: 'message', role: 'assistant', content: text.slice(0, MAX_CONTENT_LENGTH), timestamp: parsed.timestamp });
            }

            // Then unshift tool_use blocks (they'll appear before the text in the final order)
            if (contentBlocks) {
              for (let j = contentBlocks.length - 1; j >= 0; j--) {
                const block = contentBlocks[j];
                if (block.type === 'tool_use' && block.name) {
                  const desc = describeInput(block.input);
                  const item: ActivityItem = { kind: 'tool', toolName: block.name as string, content: desc };
                  if (block.input && typeof block.input === 'object') {
                    const inp = block.input as Record<string, unknown>;
                    if (block.name === 'Edit') {
                      if (typeof inp.old_string === 'string') item.oldString = inp.old_string.slice(0, MAX_CONTENT_LENGTH);
                      if (typeof inp.new_string === 'string') item.newString = inp.new_string.slice(0, MAX_CONTENT_LENGTH);
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
                  // Compute duration from pre-pass map
                  const blockId = (block as Record<string, unknown>).id as string | undefined;
                  if (blockId) {
                    const dur = toolDurations.get(blockId);
                    if (dur !== undefined) item.durationMs = dur;
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
          if (messageCount >= MAX_FEED_MESSAGES) break;
        }
      } catch {
        // skip
      }
    }

    // Incrementally scan for compact_boundary events (avoids re-reading entire file)
    const { compactCount, isCompacting } = detectCompactionIncremental(filePath, stat.size);

    const lastActivity = new Date(fileModifiedMs).toISOString();

    // Detect "DONE" command: scan back for the most recent user message that is NOT a tool_result
    const lastUserIsDone = detectLastUserIsDone(last30);

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
            // MCP tools and known long-running tools — show working/thinking, never flag as permission.
            // Real permission prompts are detected by the screen-based permissionChecker.
            state = ageSec < 8 ? 'working' : 'thinking';
          } else if (ageSec < 5) {
            state = 'working';
          } else if (ageSec > 8) {
            state = 'waiting';
            needsPermission = true;
          } else {
            state = 'thinking';
          }
        }
      } else {
        stateHint = 'assistant_text';
        state = ageSec < 3 ? 'working' : 'waiting';
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
        state = ageSec < 8 ? 'working' : 'thinking';
      } else {
        stateHint = 'user_input';
        state = ageSec < 8 ? 'working' : 'thinking';
      }
    } else {
      stateHint = 'none';
      state = 'waiting';
    }

    const result = {
      state,
      lastActivity,
      lastMessage,
      activityFeed: activityFeed.length > 0 ? activityFeed : undefined,
      model,
      inputTokens,
      compactCount: compactCount > 0 ? compactCount : undefined,
      isCompacting: isCompacting || undefined,
      needsPermission: needsPermission || undefined,
      permissionPromptText,
      lastUserIsDone: lastUserIsDone || undefined,
      permissionMode,
      pendingQuestion,
    };
    transcriptCache.set(filePath, { mtimeMs: fileModifiedMs, fileSize: stat.size, fileModifiedMs, lastCheckedAt: now, stateHint, result, dirty: false });
    return result;
  } catch {
    return {
      state: 'closed',
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
  lastUserIsDone?: boolean;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
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
    let lastUserIsDone = false;
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
          if (role === 'user' && /^done[.!\s]*$/i.test(text.trim())) lastUserIsDone = true;
          activityFeed.unshift({
            kind: 'message',
            role: role as 'user' | 'assistant',
            content: text.slice(0, MAX_CONTENT_LENGTH),
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
          state = ageSec < 8 ? 'working' : 'thinking';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'reasoning') {
          stateHint = 'codex_reasoning';
          state = ageSec < 6 ? 'thinking' : 'working';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'function_call_output') {
          stateHint = 'tool_result';
          state = ageSec < 8 ? 'working' : 'thinking';
          break;
        }
        if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
          if (parsed.payload.role === 'user') {
            stateHint = 'user_input';
            state = ageSec < 8 ? 'working' : 'thinking';
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

    const result = {
      state,
      lastActivity: new Date(fileModifiedMs).toISOString(),
      lastMessage,
      activityFeed: activityFeed.length > 0 ? activityFeed : undefined,
      model,
      inputTokens,
      lastUserIsDone: lastUserIsDone || undefined,
    };
    transcriptCache.set(filePath, { mtimeMs: fileModifiedMs, fileSize: stat.size, fileModifiedMs, lastCheckedAt: now, stateHint, result, dirty: false });
    return result;
  } catch {
    return {
      state: 'closed',
      lastActivity: new Date().toISOString(),
    };
  }
}

export function readSlug(filePath: string): string | undefined {
  if (isCodexTranscript(filePath)) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { slug?: string };
        if (parsed.slug && typeof parsed.slug === 'string') {
          return parsed.slug;
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

export function readProposedName(sessionId: string, transcriptPath: string): string | undefined {
  const cached = proposedNameCache.get(sessionId);
  if (cached !== undefined) return cached;

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

export function readSubagents(cwd: string, sessionId: string): Subagent[] {
  if (cwd.replace(/\\/g, '/').includes('/.codex/')) return [];
  const slug = cwdToSlug(cwd);
  const subagentsDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    slug,
    sessionId,
    'subagents'
  );

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
