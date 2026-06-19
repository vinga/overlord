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

// Env vars the Claude Code harness injects into its OWN child processes. If the
// Overlord server was itself launched from inside a Claude Code session (e.g.
// `npm run dev` run from the CLI, or a restart triggered via the Bash tool),
// these leak into process.env and would be inherited by every PTY-spawned
// claude. CLAUDE_CODE_CHILD_SESSION=1 in particular makes the spawned claude
// run as a non-persisting CHILD session — it writes no ~/.claude/projects
// transcript and no {pid}.json, so Overlord can never link it and the worker is
// stuck "Waiting for Claude to initialize" forever. Strip them so every spawn
// is a clean top-level session regardless of how the server was started.
const PARENT_SESSION_ENV_VARS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'AI_AGENT',
  'CLAUDE_EFFORT',
];

function sanitizedSpawnEnv(): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-color' } as Record<string, string>;
  for (const key of PARENT_SESSION_ENV_VARS) delete env[key];
  return env;
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, import('node-pty').IPty>();

  spawn(sessionId: string, cwd: string, cols: number, rows: number, args: string[] = [], executable?: string, _retryCount = 0): void {
    if (!pty) {
      this.emit('error', sessionId, 'node-pty is not available on this system');
      return;
    }
    const MAX_RETRIES = 4;
    const spawnedAt = Date.now();
    const bin = executable ?? CLAUDE_BIN;
    // Raw shells don't retry on quick exit — user may deliberately type `exit`.
    const allowRetry = executable === undefined;
    const ptyProcess = pty.spawn(bin, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: sanitizedSpawnEnv(),
    });
    this.sessions.set(sessionId, ptyProcess);
    this.emit('pid-ready', sessionId, ptyProcess.pid);
    let lastOutput = '';
    ptyProcess.onData((data) => {
      lastOutput = (lastOutput + data).slice(-500); // keep last 500 chars
      this.emit('output', sessionId, data);
    });
    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      const aliveMs = Date.now() - spawnedAt;
      // If PTY died within 3s, likely a ConPTY AttachConsole race — retry
      if (allowRetry && aliveMs < 3000 && _retryCount < MAX_RETRIES) {
        console.warn(`[PtyManager] PTY ${sessionId.slice(0, 12)} exited after ${aliveMs}ms (code ${exitCode}), retrying (${_retryCount + 1}/${MAX_RETRIES})...\n  lastOutput: ${JSON.stringify(lastOutput.trim().slice(-200))}`);
        setTimeout(() => this.spawn(sessionId, cwd, cols, rows, args, executable, _retryCount + 1), 500 * (_retryCount + 1));
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

  /** Gracefully kill all PTY sessions (used during server shutdown). */
  killAll(): void {
    for (const [id, proc] of this.sessions) {
      try { proc.kill(); } catch { /* ignore */ }
      this.sessions.delete(id);
    }
  }
}
