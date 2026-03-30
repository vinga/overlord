import { EventEmitter } from 'events';
import { execSync } from 'child_process';

let pty: typeof import('node-pty') | null = null;
try {
  const mod = await import('node-pty');
  pty = mod;
} catch (err) {
  console.warn('[PtyManager] node-pty not available:', (err as Error).message);
}

// Resolve the claude executable path once at startup
function resolveClaude(): string {
  try {
    const result = execSync('where claude', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    const normalized = result.replace(/\\/g, '/');
    console.log('[PtyManager] claude resolved to:', normalized);
    return normalized;
  } catch {
    // Fallback to common install location
    const profile = (process.env.USERPROFILE ?? 'C:/Users/kamil').replace(/\\/g, '/');
    const fallback = `${profile}/.local/bin/claude.exe`;
    console.warn('[PtyManager] `where claude` failed, falling back to:', fallback);
    return fallback;
  }
}

const CLAUDE_BIN = resolveClaude();

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, import('node-pty').IPty>();

  spawn(sessionId: string, cwd: string, cols: number, rows: number, args: string[] = []): void {
    if (!pty) {
      this.emit('error', sessionId, 'node-pty is not available on this system');
      return;
    }
    const ptyProcess = pty.spawn(CLAUDE_BIN, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-color' } as Record<string, string>,
    });
    this.sessions.set(sessionId, ptyProcess);
    ptyProcess.onData((data) => this.emit('output', sessionId, data));
    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
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
