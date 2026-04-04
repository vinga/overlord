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

// Pending requests: resolve/reject keyed by insertion order
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
    // Reject any pending requests
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

  // Capture stderr for debugging but don't act on it
  proc.stderr.on('data', (d: Buffer) => {
    console.warn('[injector stderr]', d.toString().trim());
  });
}

function ensureDaemon(): Promise<void> {
  if (proc && ready) return Promise.resolve();
  if (!proc) startDaemon();

  // Wait until ready signal arrives
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (ready) { clearInterval(check); resolve(); }
      else if (!proc) { clearInterval(check); reject(new Error('Injector failed to start')); }
    }, 50);
    setTimeout(() => { clearInterval(check); reject(new Error('Injector startup timed out')); }, 15_000);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

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
    const timer = setTimeout(() => resolve(), 5000); // timeout = silently succeed
    const wrapped = (_val?: string | null) => { clearTimeout(timer); resolve(); };
    const wrappedReject = (e: Error) => { clearTimeout(timer); reject(e); };
    pending.push({ resolve: wrapped, reject: wrappedReject, type: 'inject' });
    const cmd = JSON.stringify({ action: 'consoleInput', pid, text }) + '\n';
    proc!.stdin.write(cmd);
  });
}

export async function readScreen(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  await ensureDaemon();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove from pending on timeout
      const idx = pending.findIndex(p => p.resolve === resolveWrapper);
      if (idx !== -1) pending.splice(idx, 1);
      resolve(null);
    }, 3_000);

    const resolveWrapper = (val?: string | null) => {
      clearTimeout(timer);
      resolve(val ?? null);
    };
    const rejectWrapper = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };

    pending.push({ resolve: resolveWrapper, reject: rejectWrapper, type: 'read' });
    const cmd = JSON.stringify({ action: 'read', pid, lines: 25 }) + '\n';
    proc!.stdin.write(cmd);
  });
}
