import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as os from 'os';

let pty: typeof import('node-pty') | null = null;
try {
  const mod = await import('node-pty');
  pty = mod;
} catch (err) {
  console.warn('[PtyManager] node-pty not available:', (err as Error).message);
}

// Resolve the claude executable path once at startup
function resolveClaude(): string {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where claude' : 'which claude';
  try {
    const result = execSync(whichCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    const normalized = result.replace(/\\/g, '/');
    console.log('[PtyManager] claude resolved to:', normalized);
    return normalized;
  } catch {
    // Fallback to common install locations
    const home = os.homedir().replace(/\\/g, '/');
    const fallback = isWindows
      ? `${home}/.local/bin/claude.exe`
      : `${home}/.local/bin/claude`;
    console.warn(`[PtyManager] \`${whichCmd}\` failed, falling back to:`, fallback);
    return fallback;
  }
}

const CLAUDE_BIN = resolveClaude();

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, import('node-pty').IPty>();

  spawn(sessionId: string, cwd: string, cols: number, rows: number, args: string[] = [], _retryCount = 0): void {
    if (!pty) {
      this.emit('error', sessionId, 'node-pty is not available on this system');
      return;
    }
    const MAX_RETRIES = 4;
    const spawnedAt = Date.now();
    const ptyProcess = pty.spawn(CLAUDE_BIN, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-color' } as Record<string, string>,
    });
    this.sessions.set(sessionId, ptyProcess);
    this.emit('pid-ready', sessionId, ptyProcess.pid);
    ptyProcess.onData((data) => this.emit('output', sessionId, data));
    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      const aliveMs = Date.now() - spawnedAt;
      // If PTY died within 3s, likely a ConPTY AttachConsole race — retry
      if (aliveMs < 3000 && _retryCount < MAX_RETRIES) {
        console.warn(`[PtyManager] PTY ${sessionId.slice(0, 12)} exited after ${aliveMs}ms (code ${exitCode}), retrying (${_retryCount + 1}/${MAX_RETRIES})...`);
        setTimeout(() => this.spawn(sessionId, cwd, cols, rows, args, _retryCount + 1), 500 * (_retryCount + 1));
        return;
      }
      this.emit('exit', sessionId, exitCode ?? 0);
    });
  }

  write(sessionId: string, data: string): boolean {
    const p = this.sessions.get(sessionId);
    if (!p) return false;
    p.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  kill(sessionId: string): void {
    this.sessions.get(sessionId)?.kill();
    this.sessions.delete(sessionId);
  }

  getPid(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.pid;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}
