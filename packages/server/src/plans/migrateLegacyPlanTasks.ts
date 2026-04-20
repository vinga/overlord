import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlanStore } from './planStore.js';
import type { PlanStatus } from './types.js';

/**
 * Legacy plan task shape, as previously stored on `OverlordSession.planTasks[]`.
 * The field has been removed from the OverlordSession TypeScript type; legacy
 * JSON files on disk may still carry it and this migration drains them.
 */
interface LegacyPlanTask {
  planToolUseId?: string;
  planContent?: string;
  planStatus?: 'approved' | 'rejected' | 'pending';
  title?: string;
  summary?: string;
  createdAt?: string;
}

export interface MigrationResult {
  attempted: number;
  migrated: number;
  skipped: number;
  errors: string[];
  markerWritten: boolean;
}

function defaultBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, '.claude', 'overlord');
}

function legacyStatusToPlanStatus(status: LegacyPlanTask['planStatus']): PlanStatus {
  if (status === 'approved') return 'active';
  if (status === 'rejected') return 'archived';
  return 'draft';
}

function readLegacyFields(
  obj: unknown,
): { overlordId?: string; cwd?: string; planTasks?: LegacyPlanTask[] } | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  return {
    overlordId: typeof rec.overlordId === 'string' ? rec.overlordId : undefined,
    cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
    planTasks: Array.isArray(rec.planTasks) ? (rec.planTasks as LegacyPlanTask[]) : undefined,
  };
}

/**
 * One-time migration: convert any legacy `planTasks[]` arrays found in
 * OverlordSession JSON files into plan files via `planStore`, then strip the
 * field from the JSON. Idempotent via marker file.
 *
 * Reads JSON directly rather than through sessionStore because the field has
 * been removed from the typed OverlordSession shape — the canonical store no
 * longer exposes it after boot.
 */
export function migrateLegacyPlanTasks(
  planStore: PlanStore,
  opts: { baseDir?: string } = {},
): MigrationResult {
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const marker = path.join(baseDir, '.plans-migration-v1-done');
  const result: MigrationResult = {
    attempted: 0,
    migrated: 0,
    skipped: 0,
    errors: [],
    markerWritten: false,
  };

  if (fs.existsSync(marker)) return result;

  const dirs = [
    path.join(baseDir, 'overlord-sessions'),
    path.join(baseDir, 'overlord-sessions-archive'),
  ];

  for (const dir of dirs) {
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const full = path.join(dir, f);
      let raw: string;
      let parsed: Record<string, unknown>;
      try {
        raw = fs.readFileSync(full, 'utf-8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        result.errors.push(`read ${full}: ${(err as Error).message}`);
        continue;
      }

      const fields = readLegacyFields(parsed);
      const tasks = fields?.planTasks ?? [];
      if (!fields?.overlordId || !fields.cwd || tasks.length === 0) continue;

      result.attempted += tasks.length;
      let ok = true;
      for (const t of tasks) {
        if (!t.planToolUseId) { result.skipped++; continue; }
        try {
          planStore.upsertFromClaude({
            overlordId: fields.overlordId,
            cwd: fields.cwd,
            claudePlanToolUseId: t.planToolUseId,
            body: t.planContent ?? '',
            status: legacyStatusToPlanStatus(t.planStatus),
            title: t.title ?? t.summary,
          });
          result.migrated++;
        } catch (err) {
          result.errors.push(`upsert ${t.planToolUseId}: ${(err as Error).message}`);
          ok = false;
        }
      }

      if (ok) {
        delete (parsed as Record<string, unknown>).planTasks;
        try {
          const tmp = `${full}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8');
          fs.renameSync(tmp, full);
        } catch (err) {
          result.errors.push(`strip ${full}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (result.errors.length === 0) {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
      result.markerWritten = true;
    } catch (err) {
      result.errors.push(`marker: ${(err as Error).message}`);
    }
  }

  return result;
}
