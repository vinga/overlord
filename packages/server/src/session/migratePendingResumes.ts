import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sessionStore } from './sessionStore.js';

function normalizePath(p: string): string {
  const wslMatch = p.match(/^\/mnt\/([a-z])\/(.*)/i);
  if (wslMatch) return `${wslMatch[1]}:/${wslMatch[2]}`.toLowerCase();
  return p.replace(/\\/g, '/').toLowerCase();
}

interface LegacyEntry {
  cwd?: string;
  resumeSessionId?: string;
  timestamp?: number;
}

const OVERLORD_DIR = path.join(os.homedir(), '.claude', 'overlord');
const LEGACY_FILE = path.join(OVERLORD_DIR, 'pending-resumes.json');
const MARKER = path.join(OVERLORD_DIR, '.migration-pending-resumes-v1');
const BACKUP_DIR = path.join(OVERLORD_DIR, '.legacy-backup');

/**
 * One-shot fold of `pending-resumes.json` into sessionStore. Each legacy entry
 * is written onto the OverlordSession that owns `resumeSessionId` as a
 * `pendingResume: { cwd, at }`. After folding, the legacy file is moved to
 * `.legacy-backup/` and a marker is written so the migration is idempotent.
 */
export function migratePendingResumes(): void {
  if (!fs.existsSync(LEGACY_FILE)) return;
  if (fs.existsSync(MARKER)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
  } catch (err) {
    console.warn('[migrate:pending-resumes] read failed:', (err as Error).message);
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('[migrate:pending-resumes] parse failed:', (err as Error).message);
    return;
  }

  if (!Array.isArray(data)) {
    console.warn('[migrate:pending-resumes] legacy file is not an array — skipping');
    return;
  }

  let folded = 0;
  for (const entry of data as LegacyEntry[]) {
    if (!entry?.cwd || !entry.resumeSessionId || !entry.timestamp) continue;
    const updated = sessionStore.patchBySessionId(entry.resumeSessionId, {
      pendingResume: { cwd: normalizePath(entry.cwd), at: entry.timestamp },
    });
    if (updated) folded += 1;
  }

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `pending-resumes-${ts}.json`);
    fs.renameSync(LEGACY_FILE, dest);
    fs.writeFileSync(MARKER, new Date().toISOString(), 'utf-8');
    console.log(`[migrate:pending-resumes] folded ${folded} entries; backup → ${dest}`);
  } catch (err) {
    console.warn('[migrate:pending-resumes] backup/marker write failed:', (err as Error).message);
  }
}
