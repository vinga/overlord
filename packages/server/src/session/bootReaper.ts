import { readLivePtyEntries } from './liveAtShutdownStore.js';
import { isOverlordPtyProcess, killProcessTree } from '../pty/processTree.js';

/**
 * Kill PTY children left behind by a previous server instance.
 *
 * `shutdown()` kills the live PTY set on SIGTERM/SIGINT/SIGHUP, but a `kill -9`,
 * a crash, a machine reboot, or the restart script's 2s SIGKILL escalation skips
 * it entirely. Those children are reparented to init and keep running with their
 * whole MCP subtree. Worse, `consumeLivePtyFallback` refuses the heartbeat while
 * any recorded pid is alive, so the sessions are never auto-resumed either — the
 * work is simply stranded.
 *
 * Running this BEFORE the live-set consume fixes both halves: the orphans die,
 * and the fallback's "every recorded pid is dead" precondition then holds, so the
 * same sessions resume normally.
 *
 * Every candidate is identity-checked (`___OVR:` marker plus sid or age) before
 * being signalled — a recorded pid can belong to an unrelated process after a
 * reboot. Bridge and user-launched Claude processes are never in the heartbeat
 * and never carry the marker, so they are not reachable from here.
 *
 * Disable with `OVERLORD_BOOT_REAP=0`.
 */
export function reapPreviousInstance(): number {
  const flag = process.env.OVERLORD_BOOT_REAP;
  if (flag === '0' || flag === 'false') {
    console.log('[boot-reap] disabled via OVERLORD_BOOT_REAP');
    return 0;
  }

  const entries = readLivePtyEntries();
  if (entries.length === 0) return 0;

  let reaped = 0;
  for (const entry of entries) {
    if (!entry.pid || entry.pid <= 1 || entry.pid === process.pid) continue;
    if (!isOverlordPtyProcess(entry.pid, entry.sessionId)) continue;
    killProcessTree(entry.pid);
    reaped++;
    console.log(
      `[boot-reap] killed orphan pid=${entry.pid} session=${entry.sessionId.slice(0, 8)} ovr=${entry.ovrId}`,
    );
  }

  if (reaped > 0) {
    console.log(`[boot-reap] killed ${reaped} orphan(s) from a previous instance`);
  }
  return reaped;
}
