import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, unlinkSync } from 'fs';
import * as os from 'os';

const WORKER_CWD = join(os.homedir(), '.claude', 'overlord', 'query-worker');

let claudeBinCache: string | null = null;

function resolveClaude(): string {
  if (claudeBinCache) return claudeBinCache;
  const whichCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  try {
    claudeBinCache = execSync(whichCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
  } catch {
    const ext = process.platform === 'win32' ? '.exe' : '';
    claudeBinCache = os.homedir() + `/.local/bin/claude${ext}`;
  }
  return claudeBinCache;
}

function deleteWorkerSessionFile(pid: number): void {
  const filePath = join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
  try { unlinkSync(filePath); } catch { /* already gone */ }
}

interface QueueItem {
  prompt: string;
  timeoutMs: number;
  /** Model id passed to `--model`; `null` lets the claude CLI pick its default. */
  model: string | null;
  /** Extra CLI flags appended after the model (e.g. `--strict-mcp-config`). */
  extraArgs: string[];
  validate?: () => boolean;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
}

let activeChild: ReturnType<typeof spawn> | null = null;
let processing = false;
const queue: QueueItem[] = [];

function processNext(): void {
  if (processing) return;

  // Skip invalidated items at the front
  while (queue.length > 0) {
    const item = queue[0];
    if (!item.validate || item.validate()) break;
    queue.shift();
    item.reject(new Error('invalidated'));
  }

  if (queue.length === 0) return;

  processing = true;
  const item = queue.shift()!;

  // Final validate check right before running
  if (item.validate && !item.validate()) {
    item.reject(new Error('invalidated'));
    processing = false;
    processNext();
    return;
  }

  const bin = resolveClaude();
  try { mkdirSync(WORKER_CWD, { recursive: true }); } catch { /* ignore */ }

  console.log(`[worker] new query — queue remaining: ${queue.length}`);

  const args = ['-p', item.prompt];
  if (item.model) args.push('--model', item.model);
  args.push(...item.extraArgs);
  const child = spawn(bin, args, {
    encoding: 'utf-8',
    cwd: WORKER_CWD,
  } as Parameters<typeof spawn>[2]);
  activeChild = child;

  let stdout = '';
  let stderr = '';

  const timer = setTimeout(() => {
    child.kill();
    item.reject(new Error('claude query timed out'));
  }, item.timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', (err) => {
    clearTimeout(timer);
    activeChild = null;
    processing = false;
    item.reject(err);
    processNext();
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    // Delete the session file by PID — prevents accumulation in the UI
    if (child.pid) deleteWorkerSessionFile(child.pid);
    activeChild = null;
    processing = false;
    if (code !== 0) item.reject(new Error(stderr.trim() || `claude exited with code ${String(code)}`));
    else item.resolve(stdout.trim());
    processNext();
  });
}

export const DEFAULT_QUERY_MODEL = 'claude-haiku-4-5-20251001';

export interface ClaudeQueryOptions {
  /** Defaults to the cheap classifier model; pass `null` for the CLI default. */
  model?: string | null;
  /** Extra CLI flags, e.g. `['--strict-mcp-config', '--tools', '']` to skip MCP/tool startup. */
  extraArgs?: string[];
  /** Jump ahead of queued background jobs (classifiers, intent summaries). */
  priority?: boolean;
}

/**
 * Flags that skip MCP server startup and tool registration. For a plain
 * text answer that cuts ~2.5s of `claude -p` boot time. Not `--bare`: that
 * also skips OAuth, so the worker would run as "not logged in".
 */
export const NO_TOOLS_ARGS: readonly string[] = ['--strict-mcp-config', '--tools', ''];

export function runClaudeQuery(
  prompt: string,
  timeoutMs = 30_000,
  validate?: () => boolean,
  options: ClaudeQueryOptions = {},
): Promise<string> {
  const model = options.model === undefined ? DEFAULT_QUERY_MODEL : options.model;
  const extraArgs = options.extraArgs ?? [];
  return new Promise((resolve, reject) => {
    const item: QueueItem = { prompt, timeoutMs, model, extraArgs, validate, resolve, reject };
    if (options.priority) queue.unshift(item); else queue.push(item);
    processNext();
  });
}

/** Kill the currently running claude process and drain all pending queue items. */
export function killClaudeWorker(): void {
  const items = queue.splice(0);
  for (const item of items) item.reject(new Error('worker killed'));
  if (activeChild) {
    try { activeChild.kill(); } catch { /* ignore */ }
    activeChild = null;
  }
}
