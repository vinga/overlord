import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sessionStore } from './sessionStore.js';
import type { LineageEntry, OverlordSession, SessionProvider } from '../types.js';

interface LegacyEntry {
  sessionId?: string;
  overlordId?: string;
  sessionHistory?: Array<{ sessionId: string; attachedAt: number }>;
  provider?: SessionProvider;
  providerSessionId?: string;
  cwd?: string;
  sessionType?: OverlordSession['sessionType'];
  launchMethod?: string;
  replacedBy?: string;
  startedAt?: number;
  pid?: number;
  resumedFrom?: string;
  userAccepted?: boolean;
  bridgePipeName?: string;
  bridgeMarker?: string;
  transcriptPath?: string;
  proposedName?: string;
  name?: string;
}

const OVERLORD_DIR = path.join(os.homedir(), '.claude', 'overlord');
const LEGACY_FILE = path.join(OVERLORD_DIR, 'known-sessions.json');
const MARKER = path.join(OVERLORD_DIR, '.migration-known-sessions-v1');
const BACKUP_DIR = path.join(OVERLORD_DIR, '.legacy-backup');

function mapSessionType(entry: LegacyEntry): OverlordSession['sessionType'] {
  if (entry.sessionType) return entry.sessionType;
  const lm = entry.launchMethod;
  if (lm === 'overlord-pty' || lm === 'overlord-resume') return 'embedded';
  if (lm === 'ide') return 'ide';
  return 'plain';
}

/**
 * One-shot fold of `known-sessions.json` into sessionStore. Each legacy entry's
 * durable fields are merged into the corresponding OverlordSession (matched by
 * overlordId, falling back to sessionId via the sid index). Missing overlord
 * records are NOT created here — sessionStore is the source of identity, and a
 * legacy row with no matching overlord is junk left over from earlier formats.
 *
 * After folding, the legacy file is moved to `.legacy-backup/` (rollback-safe)
 * and a marker file is written so the migration is idempotent.
 */
export function migrateKnownSessions(): void {
  if (!fs.existsSync(LEGACY_FILE)) return;
  if (fs.existsSync(MARKER)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
  } catch (err) {
    console.warn('[migrate:known-sessions] read failed:', (err as Error).message);
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('[migrate:known-sessions] parse failed:', (err as Error).message);
    return;
  }

  if (!Array.isArray(data)) {
    console.warn('[migrate:known-sessions] legacy file is not an array — skipping');
    return;
  }

  let folded = 0;
  for (const entry of data as LegacyEntry[]) {
    if (!entry?.sessionId) continue;
    const ovrId = entry.overlordId
      ?? sessionStore.resolveOverlordId(entry.sessionId);
    if (!ovrId) continue;

    const rec = sessionStore.getByOverlordId(ovrId);
    if (!rec) continue;

    const patch: Partial<OverlordSession> = {};

    // Each field: only fold in when overlord record is empty for it.
    if (rec.sessionType === 'plain' && entry.sessionType !== 'plain') {
      patch.sessionType = mapSessionType(entry);
    }
    if (!rec.provider && entry.provider) patch.provider = entry.provider;
    if (!rec.providerSessionId && entry.providerSessionId) patch.providerSessionId = entry.providerSessionId;
    if (!rec.replacedBy && entry.replacedBy) patch.replacedBy = entry.replacedBy;
    if (!rec.resumedFrom && entry.resumedFrom) patch.resumedFrom = entry.resumedFrom;
    if (rec.userAccepted === undefined && entry.userAccepted !== undefined) patch.userAccepted = entry.userAccepted;
    if (!rec.bridgePipeName && entry.bridgePipeName) patch.bridgePipeName = entry.bridgePipeName;
    if (!rec.bridgeMarker && entry.bridgeMarker) patch.bridgeMarker = entry.bridgeMarker;
    if (!rec.proposedName && entry.proposedName) patch.proposedName = entry.proposedName;

    // Lineage history: union legacy sessionHistory into rec.lineage.history,
    // preserving currentSessionId. Only adds entries that are missing.
    if (entry.sessionHistory && Array.isArray(entry.sessionHistory)) {
      const seen = new Set(rec.lineage.history.map(h => h.sessionId));
      const additions: LineageEntry[] = [];
      for (const h of entry.sessionHistory) {
        if (!h?.sessionId || seen.has(h.sessionId)) continue;
        additions.push({ sessionId: h.sessionId, attachedAt: h.attachedAt ?? Date.now() });
      }
      if (additions.length) {
        const merged = [...rec.lineage.history, ...additions].sort((a, b) => a.attachedAt - b.attachedAt);
        patch.lineage = { currentSessionId: rec.lineage.currentSessionId, history: merged };
      }
    }

    if (Object.keys(patch).length > 0) {
      sessionStore.patch(ovrId, patch);
      folded += 1;
    }
  }

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `known-sessions-${ts}.json`);
    fs.renameSync(LEGACY_FILE, dest);
    fs.writeFileSync(MARKER, new Date().toISOString(), 'utf-8');
    console.log(`[migrate:known-sessions] folded ${folded} entries; backup → ${dest}`);
  } catch (err) {
    console.warn('[migrate:known-sessions] backup/marker write failed:', (err as Error).message);
  }
}
