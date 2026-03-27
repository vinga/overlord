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
const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

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
      req.resolve();
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

export async function injectText(pid: number, text: string, extraEnter = false): Promise<void> {
  await ensureDaemon();

  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    const cmd = JSON.stringify({ pid, text, extraEnter }) + '\n';
    proc!.stdin.write(cmd);
  });
}
