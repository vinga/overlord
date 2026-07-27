import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One session that had a live PTY when the server shut down. */
export interface LiveAtShutdownEntry {
  ovrId: string;
  sessionId: string;
}

const DIR = path.join(os.homedir(), '.claude', 'overlord');
const FILE = path.join(DIR, 'live-at-shutdown.json');

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
