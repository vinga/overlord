import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { collectDescendants, killProcessTree } from '../pty/processTree.js';

/**
 * Builds a 3-level tree that mirrors a real MCP chain:
 *   root sh → mid sh → leaf sleep
 * i.e. claude → `npm exec chrome-devtools-mcp` → chrome-devtools-mcp → node.
 * The old one-level `pkill -P` killed only `mid`, leaving `leaf` orphaned.
 */
function spawnTree(): ChildProcess {
  return spawn('sh', ['-c', 'sh -c "sleep 120 & wait" & wait'], { stdio: 'ignore' });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { if (p.pid) process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ }
    try { if (p.pid) process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('collectDescendants', () => {
  it('walks past the first level down to the leaf', async () => {
    const root = spawnTree();
    spawned.push(root);
    await settle(500);

    const found = collectDescendants(root.pid!);
    expect(found.length).toBeGreaterThanOrEqual(2);

    // The deepest entry is the `sleep` a one-level pkill would have missed.
    const cmds = found.map((pid) => {
      try {
        return execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { return ''; }
    });
    expect(cmds.some((c) => c.includes('sleep 120'))).toBe(true);
  });

  it('returns nothing for a pid with no children', () => {
    expect(collectDescendants(1)).toEqual([]);
    expect(collectDescendants(0)).toEqual([]);
  });
});

describe('killProcessTree', () => {
  it('kills the leaf, not just the direct child', async () => {
    const root = spawnTree();
    spawned.push(root);
    await settle(500);

    const descendants = collectDescendants(root.pid!);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    killProcessTree(root.pid!, 100);
    await settle(800);

    expect(alive(root.pid!)).toBe(false);
    for (const pid of descendants) expect(alive(pid)).toBe(false);
  });

  it('never signals the current process', () => {
    expect(() => killProcessTree(process.pid)).not.toThrow();
    expect(alive(process.pid)).toBe(true);
  });
});
