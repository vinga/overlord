import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One session that had a live PTY when the server shut down. */
export interface LiveAtShutdownEntry {
  ovrId: string;
  sessionId: string;
}

/** Heartbeat variant — carries the PTY child's pid so an unclean-death
 *  recovery can prove the child is gone before resuming it. */
export interface LivePtyEntry extends LiveAtShutdownEntry {
  pid: number;
}

const DIR = path.join(os.homedir(), '.claude', 'overlord');
const FILE = path.join(DIR, 'live-at-shutdown.json');
const HEARTBEAT_FILE = path.join(DIR, 'live-pty.json');
/** Beyond this the recorded set is too stale to resume unprompted. */
const HEARTBEAT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Written by shutdown() before ptyManager.killAll() — after the kill, the
 *  in-memory ovrToPty map is the only record of which sessions were live. */
export function writeLiveAtShutdown(entries: LiveAtShutdownEntry[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ capturedAt: new Date().toISOString(), entries }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[live-at-shutdown] failed to persist:', (err as Error).message);
  }
}

/** Consume-once read: the file is deleted after a successful parse so a later
 *  restart (with no fresh capture) never resumes a stale set. Returns null
 *  when no capture exists (crash / kill -9 / pre-feature shutdown) — callers
 *  must treat null as "unknown", not "nothing was live". */
export function consumeLiveAtShutdown(): LiveAtShutdownEntry[] | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as { entries?: unknown };
    fs.unlinkSync(FILE);
    if (!Array.isArray(raw.entries)) return null;
    return raw.entries.filter((e): e is LiveAtShutdownEntry =>
      !!e && typeof (e as LiveAtShutdownEntry).ovrId === 'string'
        && typeof (e as LiveAtShutdownEntry).sessionId === 'string');
  } catch (err) {
    console.warn('[live-at-shutdown] failed to read capture:', (err as Error).message);
    try { fs.unlinkSync(FILE); } catch { /* ignore */ }
    return null;
  }
}

/** Continuously-maintained mirror of the live PTY set, written while the
 *  server runs so an unclean death (reboot, panic, kill -9) still leaves a
 *  record. `shutdown()` deletes it — the clean capture is authoritative. */
export function writeLivePtyHeartbeat(entries: LivePtyEntry[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${HEARTBEAT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2));
    fs.renameSync(tmp, HEARTBEAT_FILE);
  } catch (err) {
    console.warn('[live-pty] failed to persist heartbeat:', (err as Error).message);
  }
}

export function clearLivePtyHeartbeat(): void {
  try { fs.unlinkSync(HEARTBEAT_FILE); } catch { /* ENOENT is the normal case */ }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fallback for boots with no clean capture: read + delete the heartbeat and
 * decide whether it may be trusted. Returns null unless ALL hold:
 *  1. it parses into a non-empty entry array;
 *  2. it is younger than 24h — older sets are too stale to resume unprompted;
 *  3. it was written before the current OS boot (machine restarted, so every
 *     child is dead) OR every recorded pid is dead (kill -9 on this boot).
 *     Either way no orphaned PTY child is still running, so resuming cannot
 *     duplicate a live session.
 */
export function consumeLivePtyFallback(): LiveAtShutdownEntry[] | null {
  let raw: { updatedAt?: unknown; entries?: unknown };
  let writtenAtMs: number;
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) return null;
    writtenAtMs = fs.statSync(HEARTBEAT_FILE).mtimeMs;
    raw = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8')) as typeof raw;
    fs.unlinkSync(HEARTBEAT_FILE);
  } catch (err) {
    console.warn('[live-pty] failed to read heartbeat:', (err as Error).message);
    clearLivePtyHeartbeat();
    return null;
  }
  if (!Array.isArray(raw.entries)) return null;
  const entries = raw.entries.filter((e): e is LivePtyEntry =>
    !!e && typeof (e as LivePtyEntry).ovrId === 'string'
      && typeof (e as LivePtyEntry).sessionId === 'string');
  if (entries.length === 0) return null;

  const ageMs = Date.now() - writtenAtMs;
  if (ageMs > HEARTBEAT_MAX_AGE_MS) {
    console.log(`[live-pty] ignoring heartbeat: ${Math.round(ageMs / 3_600_000)}h old (max 24h)`);
    return null;
  }
  const bootedAtMs = Date.now() - os.uptime() * 1000;
  const preBoot = writtenAtMs < bootedAtMs;
  if (!preBoot) {
    const alive = entries.filter(e => isPidAlive(e.pid));
    if (alive.length > 0) {
      console.log(`[live-pty] ignoring heartbeat: ${alive.length} recorded PTY child(ren) still alive — server died but sessions did not`);
      return null;
    }
  }
  console.log(`[live-pty] heartbeat accepted (${preBoot ? 'written before this boot' : 'all recorded pids dead'})`);
  return entries.map(({ ovrId, sessionId }) => ({ ovrId, sessionId }));
}
