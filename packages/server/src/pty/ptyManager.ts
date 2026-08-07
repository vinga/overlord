import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as os from 'os';
import { killProcessTree } from './processTree.js';

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

// Env vars that mark a process as a CHILD of an existing Claude Code session.
// When the Overlord server is launched (or restarted) from inside a Claude
// session — e.g. via the agent's Bash tool — it inherits these. Spreading
// process.env verbatim into a spawned claude makes that claude run as a
// non-persisting child session: it writes NO transcript and NO {pid}.json, so
// Overlord (transcript-driven) gets zero signal — the PTY shows live work while
// the Conversation tab stays frozen / the worker never links. Strip them so each
// spawn is a real top-level session. See project_spawn_env_poison.
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
    const proc = this.sessions.get(sessionId);
    if (!proc) return;
    // node-pty's kill signals the pty leader only; MCP servers spawned by Claude
    // (claude → `npm exec <pkg>` → <pkg> → node) survive as orphans. Sweep the
    // subtree first, while the ppid links still point at this pid.
    const pid = proc.pid;
    if (pid) killProcessTree(pid);
    proc.kill();
    this.sessions.delete(sessionId);
  }

  getPid(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.pid;
  }

  /**
   * Find the ptySessionId (marker) of a live PTY by OS pid. Used to recognize a
   * fork/clear that reuses the same PTY process under a new Claude sessionId
   * (e.g. `--fork-session` clones). Linear scan over the small live-PTY map.
   */
  findByPid(pid: number): string | undefined {
    for (const [sessionId, proc] of this.sessions) {
      if (proc.pid === pid) return sessionId;
    }
    return undefined;
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
