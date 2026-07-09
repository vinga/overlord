import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

const AUDIT_DIR = join(os.homedir(), '.claude', 'overlord');
const AUDIT_FILE = join(AUDIT_DIR, 'deletion-audit.log');
const ROTATE_BYTES = 5 * 1024 * 1024; // 5 MB → single-generation roll

export interface DeletionAuditEntry {
  sessionId: string;
  ovrId?: string;
  reason: string;
  pid?: number;
  purgedSids: string[];
  lineageSids: string[];
  transcriptPaths: string[];
  proposedName?: string;
}

/**
 * Append-only, on-disk record of every deleteSession call. Destructive deletes
 * are otherwise only traceable via ephemeral stdout + a 500-entry in-memory ring
 * (logger.ts), so a vanished session leaves no recoverable who/why. This survives
 * restarts and scrollback churn.
 *
 * Fully guarded: an audit failure must never throw into the delete path.
 */
export function appendDeletionAudit(entry: DeletionAuditEntry): void {
  try {
    // Lightweight single-generation rotation — no cron.
    try {
      const stat = fs.statSync(AUDIT_FILE);
      if (stat.size > ROTATE_BYTES) {
        fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
      }
    } catch { /* file absent or unstatable — fine */ }

    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line);
  } catch (err) {
    console.warn('[deletionAudit] failed to write audit line:', (err as Error).message);
  }
}
