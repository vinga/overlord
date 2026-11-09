import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { globalSettingsStore } from '../session/globalSettingsStore.js';
import { resolveLazyMcp, type LazyMcpConfig, type LazyMcpServer } from './lazyMcpConfig.js';

/**
 * Lazy MCP: Overlord-spawned claude sessions get stdio MCP servers through
 * `overlord-lazy-mcp`, which answers the handshake and tool list from a cache
 * and starts the real server only on the first tool call. See
 * docs/architecture.md#lazy-mcp.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function lazyMcpDir(): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'lazy-mcp');
}

export function getLazyMcpBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  // __dirname = packages/server/src/pty → ../../../lazy-mcp
  return path.join(__dirname, '..', '..', '..', 'lazy-mcp', `overlord-lazy-mcp${ext}`);
}

/** OVERLORD_LAZY_MCP=0|false forces the feature off regardless of settings. */
export function isLazyMcpEnvDisabled(): boolean {
  const v = (process.env.OVERLORD_LAZY_MCP ?? '').toLowerCase();
  return v === '0' || v === 'false';
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Absolute path of a bare command name found on PATH, else the name as-is.
 *  Resolved here so the shim does not depend on the PATH claude passes down. */
function resolveOnPath(cmd: string): string {
  if (cmd.includes('/') || cmd.includes('\\')) return expandHome(cmd);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        // Resolve the directory, not the file: version managers put a per-shell
        // symlinked bin dir on PATH (fnm_multishells/<id>) that can vanish with
        // that shell. The file stays as named, so npm's bin shim still runs.
        return path.join(fs.realpathSync(dir), cmd + ext);
      } catch { /* keep looking */ }
    }
  }
  return cmd;
}

/** The shim invocation for one server, as an mcp-config stdio entry. */
export function shimEntry(name: string, srv: LazyMcpServer, binary: string, dir: string): { type: 'stdio'; command: string; args: string[] } {
  const realArgs = [...srv.args];
  const shimArgs = [
    '--name', name,
    '--cache', path.join(dir, `${name}.cache.json`),
    '--log', path.join(dir, `${name}.log`),
  ];
  if (srv.browser === 'shared') {
    const b = srv.sharedBrowser;
    realArgs.push('--browserUrl', `http://127.0.0.1:${b.port}`);
    shimArgs.push(
      '--chrome-port', String(b.port),
      '--chrome-user-data-dir', expandHome(b.userDataDir),
      '--chrome-path', expandHome(b.chromePath),
    );
  } else if (srv.browser === 'isolated') {
    realArgs.push('--isolated');
  }
  return { type: 'stdio', command: binary, args: [...shimArgs, '--', resolveOnPath(srv.command), ...realArgs] };
}

export function buildMcpConfig(cfg: LazyMcpConfig, binary: string, dir: string): { mcpServers: Record<string, ReturnType<typeof shimEntry>> } {
  const mcpServers: Record<string, ReturnType<typeof shimEntry>> = {};
  for (const [name, srv] of Object.entries(cfg.servers)) {
    if (srv.enabled) mcpServers[name] = shimEntry(name, srv, binary, dir);
  }
  return { mcpServers };
}

let warnedMissingBinary = false;

/**
 * Appends `--mcp-config <file>` to a claude spawn when lazy MCP is on.
 * Never blocks a spawn: any problem returns the args unchanged.
 */
export function withLazyMcpConfig(
  args: string[],
  opts: { binary?: string; dir?: string } = {},
): string[] {
  try {
    if (isLazyMcpEnvDisabled()) return args;
    const cfg = resolveLazyMcp(globalSettingsStore.get().lazyMcp);
    if (!cfg.enabled) return args;
    if (args.includes('--mcp-config')) return args;
    const binary = opts.binary ?? getLazyMcpBinaryPath();
    if (!fs.existsSync(binary)) {
      if (!warnedMissingBinary) {
        console.warn(`[lazyMcp] shim binary missing at ${binary}; spawning without it. Build: cd packages/lazy-mcp && go build -o overlord-lazy-mcp .`);
        warnedMissingBinary = true;
      }
      return args;
    }
    warnedMissingBinary = false;
    const dir = opts.dir ?? lazyMcpDir();
    const config = buildMcpConfig(cfg, binary, dir);
    if (Object.keys(config.mcpServers).length === 0) return args;
    const file = path.join(dir, 'mcp-config.json');
    const body = JSON.stringify(config, null, 2);
    fs.mkdirSync(dir, { recursive: true });
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
    if (current !== body) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
    }
    return [...args, '--mcp-config', file];
  } catch (err) {
    console.warn('[lazyMcp] skipped:', (err as Error).message);
    return args;
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface LazyMcpServerStatus {
  enabled: boolean;
  browser: LazyMcpServer['browser'];
  cache: 'present' | 'missing';
  /** Sessions running the shim for this server. */
  sessions: number;
  /** Of those, sessions whose real server has been started. */
  active: number;
  /** Where ~/.claude.json also defines a server with this name. In Overlord
   *  sessions `--mcp-config` replaces it (verified: only the shim starts);
   *  sessions started elsewhere keep using it. Informational. */
  conflicts: string[];
}

export interface LazyMcpStatus {
  enabled: boolean;
  envDisabled: boolean;
  binary: { path: string; present: boolean };
  servers: Record<string, LazyMcpServerStatus>;
}

function listProcesses(): Promise<{ pid: number; ppid: number; command: string }[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise(resolve => {
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
      }
      resolve(rows);
    });
  });
}

/** Names defined in ~/.claude.json, globally or per project, with where. */
export function claudeJsonServerNames(file = path.join(os.homedir(), '.claude.json')): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const add = (name: string, where: string) => out.set(name, [...(out.get(name) ?? []), where]);
    for (const name of Object.keys(d.mcpServers ?? {})) add(name, 'global');
    for (const [proj, v] of Object.entries(d.projects ?? {})) {
      for (const name of Object.keys(v?.mcpServers ?? {})) add(name, proj);
    }
  } catch { /* no file or unreadable */ }
  return out;
}

/** On request only — one `ps` call, never on a timer. */
export async function getLazyMcpStatus(): Promise<LazyMcpStatus> {
  const cfg = resolveLazyMcp(globalSettingsStore.get().lazyMcp);
  const binary = getLazyMcpBinaryPath();
  const dir = lazyMcpDir();
  const procs = await listProcesses();
  const childrenOf = new Map<number, number>();
  for (const p of procs) childrenOf.set(p.ppid, (childrenOf.get(p.ppid) ?? 0) + 1);
  const defined = claudeJsonServerNames();

  const servers: Record<string, LazyMcpServerStatus> = {};
  for (const [name, srv] of Object.entries(cfg.servers)) {
    const shims = procs.filter(p => p.command.includes('overlord-lazy-mcp') && p.command.includes(`--name ${name} `));
    servers[name] = {
      enabled: srv.enabled,
      browser: srv.browser,
      cache: fs.existsSync(path.join(dir, `${name}.cache.json`)) ? 'present' : 'missing',
      sessions: shims.length,
      active: shims.filter(p => (childrenOf.get(p.pid) ?? 0) > 0).length,
      conflicts: defined.get(name) ?? [],
    };
  }
  return {
    enabled: cfg.enabled && !isLazyMcpEnvDisabled(),
    envDisabled: isLazyMcpEnvDisabled(),
    binary: { path: binary, present: fs.existsSync(binary) },
    servers,
  };
}
