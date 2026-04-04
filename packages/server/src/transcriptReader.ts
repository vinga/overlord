import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WorkerState, Subagent, ActivityItem } from './types.js';

interface TranscriptCache {
  mtimeMs: number;
  result: ReturnType<typeof readTranscriptState>;
}
const transcriptCache = new Map<string, TranscriptCache>();

interface SubagentsDirCache {
  mtimeMs: number;
  agentIds: string[];
}
const subagentsDirCache = new Map<string, SubagentsDirCache>();

const proposedNameCache = new Map<string, string>();

export function clearTranscriptCache(filePath: string): void {
  transcriptCache.delete(filePath);
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

function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const val = obj.file_path ?? obj.command ?? obj.pattern ?? obj.prompt ?? obj.description ?? obj.query ?? '';
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

function detectCompaction(lines: string[]): { compactCount: number; isCompacting: boolean } {
  const now = Date.now();
  let compactCount = 0;
  let lastCompactTimestamp: number | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        timestamp?: string;
      };
      if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
        compactCount++;
        if (parsed.timestamp) {
          const ts = new Date(parsed.timestamp).getTime();
          if (!isNaN(ts)) {
            if (lastCompactTimestamp === undefined || ts > lastCompactTimestamp) {
              lastCompactTimestamp = ts;
            }
          }
        }
      }
    } catch {
      // skip
    }
  }
  const isCompacting =
    lastCompactTimestamp !== undefined && now - lastCompactTimestamp < 5000;
  return { compactCount, isCompacting };
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
  lastUserIsDone?: boolean;
} {
  try {
    const stat = fs.statSync(filePath);
    const fileModifiedMs = stat.mtimeMs;

    // Return cached result if file hasn't changed
    const cached = transcriptCache.get(filePath);
    if (cached && cached.mtimeMs === fileModifiedMs) {
      return cached.result;
    }

    const now = Date.now();
    const ageSec = (now - fileModifiedMs) / 1000;

    const MAX_FEED_MESSAGES = 100;
    const MAX_CONTENT_LENGTH = 10000;

    // Read all lines for compact scanning
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const last30 = lines.slice(-(MAX_FEED_MESSAGES * 5));

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
          message?: {
            content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
            model?: string;
            usage?: { input_tokens?: number; cache_read_input_tokens?: number };
          };
        };
        if (parsed && (parsed.type === 'user' || parsed.type === 'assistant')) {
          const rawContent = parsed.message?.content;

          // Extract model and inputTokens from the last assistant event (first one we find scanning backwards)
          if (parsed.type === 'assistant' && model === undefined) {
            if (parsed.message?.model) {
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
              activityFeed.unshift({ kind: 'message', role: 'user', content: text.slice(0, MAX_CONTENT_LENGTH) });
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
              activityFeed.unshift({ kind: 'message', role: 'assistant', content: text.slice(0, MAX_CONTENT_LENGTH) });
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

    // Scan all lines for compact_boundary events
    const { compactCount, isCompacting } = detectCompaction(lines);

    const lastActivity = new Date(fileModifiedMs).toISOString();

    // Detect "DONE" command: scan back for the most recent user message that is NOT a tool_result
    const lastUserIsDone = detectLastUserIsDone(last30);

    // Determine state
    let state: WorkerState;
    let needsPermission: boolean | undefined;
    if (lastTypedEvent?.type === 'assistant') {
      // Check if the assistant message ended with tool_use (still executing tools)
      // vs pure text (finished turn, waiting for human)
      const lastContent = lastTypedEvent.message as { content?: unknown } | undefined;
      const contentArr = Array.isArray(lastContent?.content) ? lastContent!.content as Array<{ type?: string }> : [];
      const endsWithToolUse = contentArr.length > 0 && contentArr[contentArr.length - 1]?.type === 'tool_use';

      if (endsWithToolUse) {
        state = ageSec < 8 ? 'working' : 'thinking';
      } else {
        // Claude sent a text response — waiting for user input
        state = ageSec < 3 ? 'working' : 'waiting';
      }
    } else if (lastTypedEvent?.type === 'user') {
      // Check if this is a tool_result (system providing tool output) vs human message
      const userContent = lastTypedEvent.message as { content?: unknown } | undefined;
      const userContentArr = Array.isArray(userContent?.content) ? userContent!.content as Array<{ type?: string }> : [];
      const isToolResult = userContentArr.length > 0 && userContentArr[0]?.type === 'tool_result';

      if (isToolResult) {
        // Tool result came back — Claude is processing it
        state = ageSec < 8 ? 'working' : 'thinking';
      } else if (ageSec < 8) {
        state = 'working'; // just received human input
      } else {
        state = 'thinking'; // actively processing
      }
    } else {
      // No events in transcript yet — session just started, waiting for first prompt
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
      lastUserIsDone: lastUserIsDone || undefined,
    };
    transcriptCache.set(filePath, { mtimeMs: fileModifiedMs, result });
    return result;
  } catch {
    return {
      state: 'closed',
      lastActivity: new Date().toISOString(),
    };
  }
}

export function readSlug(filePath: string): string | undefined {
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

  // Strategy 2: first user message from transcript
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
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
  const slug = cwdToSlug(cwd);
  const subagentsDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    slug,
    sessionId,
    'subagents'
  );

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
        let activityFeed: import('./types.js').ActivityItem[] | undefined;
        let model: string | undefined;

        if (fs.existsSync(transcriptFile)) {
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

  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const now = Date.now();
  return subagents.filter((s) => {
    if (s.state === 'working' || s.state === 'thinking') return true;
    const age = now - new Date(s.lastActivity).getTime();
    return age < TEN_MINUTES_MS;
  });
}
