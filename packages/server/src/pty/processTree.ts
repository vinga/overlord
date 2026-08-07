import { execSync } from 'child_process';

/**
 * Whole-subtree process termination.
 *
 * The old kill sequence was `pkill -P <pid>` followed by `kill -9 <pid>` — one
 * level deep. Real MCP servers sit two or three levels below the Claude
 * process, e.g.
 *
 *   claude → `npm exec chrome-devtools-mcp` → `chrome-devtools-mcp` → node
 *
 * so `pkill -P` only reached the `npm exec` wrapper; the actual server was
 * reparented to init and survived. Servers that exit on stdin EOF cleaned
 * themselves up, but any server holding an open handle (a spawned browser, a
 * listening socket) leaked for the lifetime of the machine.
 */

/** One `ps` snapshot → pid → children map. A single spawn instead of one
 *  `pgrep -P` per node; the tree walk then runs in memory. */
function readChildMap(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  let raw: string;
  try {
    raw = execSync('ps -axo pid,ppid', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return map;
  }
  for (const line of raw.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const kids = map.get(ppid);
    if (kids) kids.push(pid);
    else map.set(ppid, [pid]);
  }
  return map;
}

/** Every descendant of `pid`, breadth-first (shallowest first). Excludes `pid`
 *  itself and never returns this server's own pid. */
export function collectDescendants(pid: number, childMap?: Map<number, number[]>): number[] {
  if (!pid || pid <= 1) return [];
  const map = childMap ?? readChildMap();
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let frontier = [pid];
  // Depth cap is a cycle guard only — a real MCP chain is 3 levels.
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of map.get(parent) ?? []) {
        if (child <= 1 || child === process.pid || seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/**
 * Kill `pid` and everything below it.
 *
 * Descendants are snapshotted BEFORE the root dies — once the root is gone the
 * ppid links are rewritten to 1 and the tree is unrecoverable. Descendants get
 * SIGTERM first (an MCP server can flush and close its own children), the root
 * is SIGKILLed immediately, and any survivor is SIGKILLed after `graceMs`.
 *
 * The escalation runs on a timer, so this function never blocks the event loop.
 */
export function killProcessTree(pid: number, graceMs = 400): void {
  if (!pid || pid <= 1 || pid === process.pid) return;

  if (process.platform === 'win32') {
    // taskkill /T already walks the whole tree.
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }

  const descendants = collectDescendants(pid);

  // Deepest-first: give the leaf server a TERM before its wrapper disappears.
  for (const child of [...descendants].reverse()) signal(child, 'SIGTERM');
  signal(pid, 'SIGKILL');

  // A pty-spawned Claude is its own session leader (setsid), so pgid === pid and
  // the group sweep is confined to this session. When pgid differs the process
  // shares a group with someone else's shell — never signal that group.
  let pgid = 0;
  try {
    pgid = Number(
      execSync(`ps -o pgid= -p ${pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    );
  } catch { /* process already reaped */ }

  if (descendants.length === 0 && (!pgid || pgid !== pid)) return;

  setTimeout(() => {
    for (const child of [...descendants].reverse()) signal(child, 'SIGKILL');
    if (pgid === pid) {
      // Catches anything that forked out of the snapshotted tree in between.
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* group gone */ }
    }
  }, graceMs).unref();
}
