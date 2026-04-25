import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const OVERLORD_DIR = path.join(os.homedir(), '.claude', 'overlord');
const LEGACY_FILE = path.join(OVERLORD_DIR, 'deleted-sessions.json');
const MARKER = path.join(OVERLORD_DIR, '.migration-deleted-sessions-v1');
const BACKUP_DIR = path.join(OVERLORD_DIR, '.legacy-backup');

/**
 * One-shot retirement of `deleted-sessions.json`. The data was a defensive
 * tombstone against the unlink race in `deleteSession`; that guard is now
 * in-memory only with a 60s TTL. The underlying transcripts/{pid}.json files
 * for every previously-deleted sid have already been unlinked, so no fold-in
 * is required — the file is simply moved to the legacy backup.
 */
export function migrateDeletedSessions(): void {
  if (!fs.existsSync(LEGACY_FILE)) return;
  if (fs.existsSync(MARKER)) return;

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `deleted-sessions-${ts}.json`);
    fs.renameSync(LEGACY_FILE, dest);
    fs.writeFileSync(MARKER, new Date().toISOString(), 'utf-8');
    console.log(`[migrate:deleted-sessions] retired; backup → ${dest}`);
  } catch (err) {
    console.warn('[migrate:deleted-sessions] backup/marker write failed:', (err as Error).message);
  }
}
