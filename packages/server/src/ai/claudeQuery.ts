import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import * as os from 'os';

export const HAIKU_WORKER_CWD = join(os.homedir(), '.claude', 'overlord', 'haiku-worker');

let claudeBinCache: string | null = null;

function resolveClaude(): string {
  if (claudeBinCache) return claudeBinCache;
  try {
    claudeBinCache = execSync('where claude', { encoding: 'utf8' }).trim().split('\n')[0].trim();
  } catch {
    claudeBinCache = os.homedir() + '/.local/bin/claude.exe';
  }
  return claudeBinCache;
}

/** Delete the session file created by a haiku-worker process (named after its PID). */
function deleteWorkerSessionFile(pid: number): void {
  const filePath = join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
  try { unlinkSync(filePath); } catch { /* already gone */ }
}

/** Delete haiku-worker transcript files older than 15 minutes on startup. */
export function cleanupOldWorkerTranscripts(): void {
  const projectsDir = join(os.homedir(), '.claude', 'projects');
  const maxAge = 15 * 60_000; // 15 minutes
  const now = Date.now();
  // Find any directory containing 'haiku-worker' (Claude's slug may differ from ours)
  let dirs: string[];
  try { dirs = readdirSync(projectsDir); } catch { return; }
  for (const dir of dirs) {
    if (!dir.includes('haiku-worker')) continue;
    const transcriptDir = join(projectsDir, dir);
    let removed = 0;
    try {
      const files = readdirSync(transcriptDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const full = join(transcriptDir, file);
        try {
          const st = statSync(full);
          if (now - st.mtimeMs > maxAge) { unlinkSync(full); removed++; }
        } catch { /* skip */ }
      }
    } catch { continue; }
    if (removed > 0) console.log(`[worker:cleanup] removed ${removed} old transcripts from ${dir}`);
  }
}

interface QueueItem {
  prompt: string;
  timeoutMs: number;
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
  try { mkdirSync(HAIKU_WORKER_CWD, { recursive: true }); } catch { /* ignore */ }

  console.log(`[worker] new query — queue remaining: ${queue.length}`);

  const child = spawn(bin, ['-p', item.prompt, '--model', 'claude-haiku-4-5-20251001'], {
    encoding: 'utf-8',
    cwd: HAIKU_WORKER_CWD,
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

export function runClaudeQuery(
  prompt: string,
  timeoutMs = 30_000,
  validate?: () => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    queue.push({ prompt, timeoutMs, validate, resolve, reject });
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
