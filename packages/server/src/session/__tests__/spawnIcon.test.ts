import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WORKER_ICONS, isWorkerIcon } from '../../types.js';
import { PendingSpawnIcons } from '../pendingSpawnIcons.js';
import { spawnClaudeSession, type SpawnContext } from '../../pty/spawnSession.js';

describe('WORKER_ICONS / isWorkerIcon', () => {
  it('accepts every declared icon', () => {
    for (const icon of WORKER_ICONS) expect(isWorkerIcon(icon)).toBe(true);
    expect(WORKER_ICONS).toContain('user');
    expect(WORKER_ICONS).toContain('investigate');
  });

  it('rejects unknown / non-string values', () => {
    for (const bad of ['wyglup', '', 'User', undefined, null, 42, {}, ['user']]) {
      expect(isWorkerIcon(bad)).toBe(false);
    }
  });

  // Drift guard: the client keeps its own copy of the list (separate package, no
  // cross-package type import). If someone adds a glyph on one side only, the
  // server would 400 an icon the picker offers (or vice versa).
  it('matches the client-side copy of the list', () => {
    const clientTypes = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../../client/src/types.ts',
    );
    const src = fs.readFileSync(clientTypes, 'utf-8');
    const m = src.match(/export const WORKER_ICONS = \[([^\]]*)\]/);
    expect(m, 'client types.ts must export a WORKER_ICONS array literal').toBeTruthy();
    const clientIcons = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    expect(clientIcons).toEqual([...WORKER_ICONS]);
  });
});

describe('PendingSpawnIcons', () => {
  let q: PendingSpawnIcons;

  beforeEach(() => { q = new PendingSpawnIcons(); });
  afterEach(() => { vi.useRealTimers(); });

  it('track then peek returns the icon', () => {
    q.track('ovr-1', 'investigate');
    expect(q.peek('ovr-1')).toBe('investigate');
  });

  it('peek does not consume — a phantom tick must not swallow the icon', () => {
    q.track('ovr-1', 'ticket');
    expect(q.peek('ovr-1')).toBe('ticket');
    expect(q.peek('ovr-1')).toBe('ticket');
  });

  it('clear consumes', () => {
    q.track('ovr-1', 'release');
    q.clear('ovr-1');
    expect(q.peek('ovr-1')).toBeUndefined();
  });

  it('unknown ovrId peeks undefined', () => {
    expect(q.peek('ovr-nope')).toBeUndefined();
  });

  it('entries past the TTL are dropped', () => {
    vi.useFakeTimers();
    q.track('ovr-1', 'teach');
    vi.advanceTimersByTime(PendingSpawnIcons.TTL_MS - 1);
    expect(q.peek('ovr-1')).toBe('teach');
    vi.advanceTimersByTime(2);
    expect(q.peek('ovr-1')).toBeUndefined();
  });

  it('later track overwrites an earlier one for the same ovrId', () => {
    q.track('ovr-1', 'teach');
    q.track('ovr-1', 'notes');
    expect(q.peek('ovr-1')).toBe('notes');
  });
});

// --- spawnClaudeSession wiring -------------------------------------------------

interface FakeState {
  tracked: Map<string, string>;
  cleared: string[];
}

function makeCtx(opts: { spawnThrows?: boolean } = {}): { ctx: SpawnContext; state: FakeState } {
  const state: FakeState = { tracked: new Map(), cleared: [] };
  let minted = 0;
  const stateManager = {
    mintReservedOvrId: () => `ovr-fake-${++minted}`,
    trackPendingPtySpawn: () => {},
    trackPendingInitialPrompt: () => {},
    takePendingInitialPrompt: () => undefined,
    trackPendingSpawnIcon: (ovrId: string, icon: string) => { state.tracked.set(ovrId, icon); },
    clearPendingSpawnIcon: (ovrId: string) => { state.cleared.push(ovrId); state.tracked.delete(ovrId); },
  };
  const ptyManager = {
    spawn: () => { if (opts.spawnThrows) throw new Error('spawn boom'); },
  };
  const ctx = {
    ptyManager,
    stateManager,
    ovrToPty: new Map<string, string>(),
    ptyToOvr: new Map<string, string>(),
    broadcastRaw: () => {},
  } as unknown as SpawnContext;
  return { ctx, state };
}

describe('spawnClaudeSession — icon', () => {
  const cwd = process.cwd(); // exists, so the mkdir branch is skipped

  it('queues the icon under the ovrId it returns', () => {
    const { ctx, state } = makeCtx();
    const { ovrId } = spawnClaudeSession(ctx, { cwd, icon: 'investigate' });
    expect(state.tracked.get(ovrId)).toBe('investigate');
  });

  it('queues nothing when no icon is given', () => {
    const { ctx, state } = makeCtx();
    spawnClaudeSession(ctx, { cwd });
    expect(state.tracked.size).toBe(0);
  });

  // 'user' IS the default — queueing it would write a redundant field into the
  // record. Valid input, no-op effect.
  it("treats icon 'user' as a no-op", () => {
    const { ctx, state } = makeCtx();
    spawnClaudeSession(ctx, { cwd, icon: 'user' });
    expect(state.tracked.size).toBe(0);
  });

  it('clears the queued icon when the PTY spawn throws', () => {
    const { ctx, state } = makeCtx({ spawnThrows: true });
    let thrownOvrId: string | undefined;
    expect(() => {
      try {
        spawnClaudeSession(ctx, { cwd, icon: 'release' });
      } catch (err) {
        thrownOvrId = (err as Error & { ovrId?: string }).ovrId;
        throw err;
      }
    }).toThrow('spawn boom');
    expect(thrownOvrId).toBeTruthy();
    expect(state.cleared).toContain(thrownOvrId!);
    expect(state.tracked.size).toBe(0);
  });
});
