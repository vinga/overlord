import * as fs from 'fs';
import type { PtyManager } from './ptyManager.js';
import type { StateManager } from '../session/stateManager.js';
import { log } from '../logger.js';

/**
 * Shared fresh-spawn path for a new Claude session. Used by both the WS
 * `terminal:spawn` handler and the REST `POST /api/sessions/spawn` endpoint so
 * the two never diverge.
 *
 * Mints a reserved ovrId against the PTY marker (adopted by addOrUpdate when the
 * live Claude session lands), registers the pty<->ovr maps, optionally queues an
 * initial prompt to be injected once the TUI is ready (see ptyEvents output
 * handler), broadcasts `terminal:spawned`, then spawns the PTY.
 *
 * On spawn failure the maps + queued prompt are cleaned up and the thrown Error
 * is annotated with `.ovrId` so the caller can report it to the right worker.
 */
export interface SpawnContext {
  ptyManager: PtyManager;
  stateManager: StateManager;
  ovrToPty: Map<string, string>;   // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;   // ptySessionId → ovrId
  broadcastRaw: (msg: object) => void;
}

export interface SpawnOptions {
  cwd: string;
  name?: string;
  cols?: number;
  rows?: number;
  /** Injected once the freshly spawned PTY produces output (TUI ready). */
  prompt?: string;
  /** WS-owned session set to register the ids into (WS path only). */
  sessions?: Set<string>;
}

export function spawnClaudeSession(
  ctx: SpawnContext,
  opts: SpawnOptions,
): { ovrId: string; ptySessionId: string } {
  const { cwd, name } = opts;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  // Auto-create the target workspace if it doesn't exist (mirrors WS spawn).
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
    console.log(`[spawn] created directory: ${cwd}`);
  }

  // Internal PTY id — ptyManager key, marker, and ptyOutputBuffer key.
  const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Pre-mint the ovrId reserved against this PTY's marker. Adopted by
  // addOrUpdate when the live Claude session lands; the client sees only ovrId.
  const ovrId = ctx.stateManager.mintReservedOvrId(ptySessionId);
  ctx.ovrToPty.set(ovrId, ptySessionId);
  ctx.ptyToOvr.set(ptySessionId, ovrId);

  // Flag this as a fresh spawn so addOrUpdate skips the cwd-keyed pendingResumes
  // lookup (which would otherwise contaminate it with a stale resume entry from
  // another PTY in the same cwd).
  ctx.stateManager.trackPendingPtySpawn(cwd, ptySessionId);

  if (opts.sessions) { opts.sessions.add(ovrId); opts.sessions.add(ptySessionId); }

  // Queue the initial prompt BEFORE spawning. Marker-keyed (never cwd-keyed) so
  // concurrent same-cwd spawns each get their own prompt. The ptyEvents output
  // handler fires it once the TUI starts rendering.
  if (opts.prompt?.trim()) {
    ctx.stateManager.trackPendingInitialPrompt(ptySessionId, opts.prompt);
  }

  ctx.broadcastRaw({ type: 'terminal:spawned', sessionId: ovrId, pid: 0 });

  // Embed ptySessionId as a hidden marker in the session name for reliable PTY
  // linking (ConPTY on Windows may give a wrapper PID that doesn't match
  // claude.exe). Prepend the user-provided name if any.
  const sessionName = name ? `${name}___OVR:${ptySessionId}` : `___OVR:${ptySessionId}`;
  try {
    ctx.ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--name', sessionName]);
  } catch (err) {
    ctx.ovrToPty.delete(ovrId);
    ctx.ptyToOvr.delete(ptySessionId);
    ctx.stateManager.takePendingInitialPrompt(ptySessionId);
    const e = err as Error & { ovrId?: string };
    e.ovrId = ovrId;
    throw e;
  }
  log('pty:started', 'PTY session started', {
    sessionId: ovrId,
    sessionName: name ?? ptySessionId.slice(0, 8),
  });
  return { ovrId, ptySessionId };
}
