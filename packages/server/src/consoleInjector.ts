import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT = path.join(__dirname, '..', 'inject.ps1');

// ── Persistent PowerShell daemon ──────────────────────────────────────────────

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;

// Pending requests: resolve/reject keyed by insertion order (FIFO)
const pending: Array<{ resolve: (val?: string | null) => void; reject: (e: Error) => void; type: 'inject' | 'read' }> = [];

function startDaemon(): void {
  proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const rl = createInterface({ input: proc.stdout });

  rl.on('line', (line) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }

    if (msg.ready) {
      ready = true;
      return;
    }

    const req = pending.shift();
    if (!req) return;

    if (msg.ok) {
      if (req.type === 'read') {
        req.resolve(typeof msg.text === 'string' ? msg.text : null);
      } else {
        req.resolve();
      }
    } else {
      req.reject(new Error(`Injection failed: ${String(msg.error ?? 'unknown')}`));
    }
  });

  proc.on('close', () => {
    ready = false;
    proc = null;
    for (const req of pending.splice(0)) {
      req.reject(new Error('Injector process exited unexpectedly'));
    }
  });

  proc.on('error', (err) => {
    ready = false;
    proc = null;
    for (const req of pending.splice(0)) {
      req.reject(new Error(`Failed to start injector: ${err.message}`));
    }
  });

  proc.stderr.on('data', (d: Buffer) => {
    console.warn('[injector stderr]', d.toString().trim());
  });
}

function ensureDaemon(): Promise<void> {
  if (proc && ready) return Promise.resolve();
  if (!proc) startDaemon();

  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (ready) { clearInterval(check); resolve(); }
      else if (!proc) { clearInterval(check); reject(new Error('Injector failed to start')); }
    }, 50);
    setTimeout(() => { clearInterval(check); reject(new Error('Injector startup timed out')); }, 15_000);
  });
}

// ── Public API: Injection (high priority, goes directly to daemon) ───────────

export async function injectText(pid: number, text: string, extraEnter = false, raw = false): Promise<void> {
  await ensureDaemon();

  return new Promise<void>((resolve, reject) => {
    const wrapped = (_val?: string | null) => resolve();
    pending.push({ resolve: wrapped, reject, type: 'inject' });
    const cmd = JSON.stringify({ pid, text, extraEnter, raw }) + '\n';
    proc!.stdin.write(cmd);
  });
}

export async function approvePermission(pid: number, text: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await ensureDaemon();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 5000);
    const wrapped = (_val?: string | null) => { clearTimeout(timer); resolve(); };
    const wrappedReject = (e: Error) => { clearTimeout(timer); reject(e); };
    pending.push({ resolve: wrapped, reject: wrappedReject, type: 'inject' });
    const cmd = JSON.stringify({ action: 'consoleInput', pid, text }) + '\n';
    proc!.stdin.write(cmd);
  });
}

// ── Screen reading: serialized with cache ────────────────────────────────────

// Cache per-PID results to avoid redundant reads
const screenCache = new Map<number, { text: string | null; timestamp: number }>();
const SCREEN_CACHE_TTL = 5000;

// Serialized read queue — only one read in the daemon at a time
let readBusy = false;
const readQueue: Array<{ pid: number; resolve: (text: string | null) => void }> = [];

export function readScreen(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);

  // Return cached result if fresh enough
  const cached = screenCache.get(pid);
  if (cached && Date.now() - cached.timestamp < SCREEN_CACHE_TTL) {
    return Promise.resolve(cached.text);
  }

  // Check if this PID is already queued — piggyback
  const existing = readQueue.find(r => r.pid === pid);
  if (existing) {
    return new Promise<string | null>((resolve) => {
      const origResolve = existing.resolve;
      existing.resolve = (text) => { origResolve(text); resolve(text); };
    });
  }

  return new Promise<string | null>((resolve) => {
    readQueue.push({ pid, resolve });
    drainReadQueue();
  });
}

function drainReadQueue(): void {
  if (readBusy || readQueue.length === 0) return;

  // Start daemon if needed
  if (!proc || !ready) {
    ensureDaemon().then(() => drainReadQueue()).catch(() => {
      // Daemon failed — resolve all queued reads with null
      for (const r of readQueue.splice(0)) r.resolve(null);
    });
    return;
  }

  readBusy = true;
  const { pid, resolve } = readQueue.shift()!;

  const timer = setTimeout(() => {
    // Timeout: resolve null, but leave pending entry for daemon's eventual response
    readBusy = false;
    resolve(null);
    screenCache.set(pid, { text: null, timestamp: Date.now() });
    drainReadQueue();
  }, 5_000);

  const resolveWrapper = (val?: string | null) => {
    clearTimeout(timer);
    const text = val ?? null;
    screenCache.set(pid, { text, timestamp: Date.now() });
    readBusy = false;
    resolve(text);
    drainReadQueue();
  };

  const rejectWrapper = (_e: Error) => {
    clearTimeout(timer);
    screenCache.set(pid, { text: null, timestamp: Date.now() });
    readBusy = false;
    resolve(null);
    drainReadQueue();
  };

  pending.push({ resolve: resolveWrapper, reject: rejectWrapper, type: 'read' });
  const cmd = JSON.stringify({ action: 'read', pid, lines: 25 }) + '\n';
  proc!.stdin.write(cmd);
}
