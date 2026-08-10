import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sessionStore } from '../session/sessionStore.js';
import type { OverlordSession, ArchivedTranscript, PullRequestSnapshot } from '../types.js';

/**
 * Archive view built from an archived OverlordSession. Shape is kept close to the
 * pre-refactor entry so existing callers keep working; new fields `transcripts`
 * and `overlordId` expose the multi-transcript lineage.
 *
 * `transcriptPath` (singular) points at the current sessionId's archived copy for
 * back-compat (legacy readers and the transcript-viewer route).
 */
export interface ArchiveEntry {
  sessionId: string;       // current sessionId at archive time
  overlordId: string;
  roomId: string;
  cwd: string;
  name: string;
  archivedAt: string;
  transcriptPath: string;  // path of the current-session transcript (for back-compat)
  transcripts: ArchivedTranscript[];  // full lineage of archived transcripts
  pid: number;
  provider?: string;
  sessionType?: string;
  startedAt?: number;
  color?: string;
  gitBranch?: string;
  pullRequest?: PullRequestSnapshot;
  lastMessage?: string;
  lastActivity?: string;
  model?: string;
  intent?: string;
  notes?: string;
}

const ARCHIVE_BASE = path.join(os.homedir(), '.claude', 'overlord', 'archive');

export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[\\:/]/g, '-').replace(/^-+/, '');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toEntry(rec: OverlordSession): ArchiveEntry | null {
  if (!rec.archive) return null;
  const current = rec.archive.transcripts.find(t => t.sessionId === rec.lineage.currentSessionId);
  const firstTranscript = rec.archive.transcripts[0];
  const transcriptPath = current?.path ?? firstTranscript?.path ?? '';
  return {
    sessionId: rec.lineage.currentSessionId,
    overlordId: rec.overlordId,
    roomId: rec.archive.roomId,
    cwd: rec.cwd,
    name: rec.proposedName ?? rec.archive.name,
    archivedAt: rec.archive.archivedAt,
    transcriptPath,
    transcripts: rec.archive.transcripts,
    pid: 0,
    provider: rec.provider,
    sessionType: rec.sessionType,
    startedAt: rec.startedAt,
    color: rec.color,
    gitBranch: rec.archive.gitBranch,
    pullRequest: rec.archive.pullRequest,
    lastMessage: rec.lastMessage,
    lastActivity: rec.lastActivity,
    model: rec.model,
    intent: rec.intent,
    notes: rec.notes,
  };
}

export class ArchiveManager {
  isArchived(sessionId: string): boolean {
    return !!sessionStore.getBySessionId(sessionId)?.archive;
  }

  archive(params: {
    sessionId: string;
    cwd: string;
    name: string;
    pid: number;
    sourceTranscriptPath: string | null;
    provider?: string;
    sessionType?: string;
    startedAt?: number;
    color?: string;
    gitBranch?: string;
    pullRequest?: PullRequestSnapshot;
    lastMessage?: string;
    lastActivity?: string;
    model?: string;
  }): ArchiveEntry | null {
    const rec = sessionStore.getBySessionId(params.sessionId);
    if (!rec) return null;                               // unknown overlord
    if (rec.archive) return toEntry(rec);                // already archived — idempotent

    if (!params.sourceTranscriptPath || !fs.existsSync(params.sourceTranscriptPath)) {
      return null;
    }

    const slug = cwdToSlug(params.cwd);
    const destDir = path.join(ARCHIVE_BASE, slug, rec.overlordId);
    ensureDir(destDir);

    // Copy each lineage entry's transcript if it exists on disk.
    // Current session: use the resolved sourceTranscriptPath the caller passed
    // (which may have walked the --resume chain).
    const transcripts: ArchivedTranscript[] = [];
    for (const h of rec.lineage.history) {
      const src = h.sessionId === params.sessionId ? params.sourceTranscriptPath : h.transcriptPath;
      if (!src || !fs.existsSync(src)) continue;
      const dest = path.join(destDir, `${h.sessionId}.jsonl`);
      try {
        fs.copyFileSync(src, dest);
        transcripts.push({ sessionId: h.sessionId, path: dest });
      } catch { /* skip this transcript */ }
    }
    if (transcripts.length === 0) return null;

    // Also update durable fields from the caller (latest message/activity/model).
    sessionStore.patch(rec.overlordId, {
      lastMessage: params.lastMessage ?? rec.lastMessage,
      lastActivity: params.lastActivity ?? rec.lastActivity,
      model: params.model ?? rec.model,
    });

    const updated = sessionStore.archive(rec.overlordId, {
      roomId: slug,
      name: params.name,
      gitBranch: params.gitBranch,
      pullRequest: params.pullRequest,
      transcripts,
    });
    return updated ? toEntry(updated) : null;
  }

  list(): ArchiveEntry[] {
    const out: ArchiveEntry[] = [];
    for (const rec of sessionStore.listArchived()) {
      const e = toEntry(rec);
      if (e) out.push(e);
    }
    return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  listByRoom(roomId: string): ArchiveEntry[] {
    return this.list().filter(e => e.roomId === roomId);
  }

  get(sessionId: string): ArchiveEntry | null {
    const rec = sessionStore.getArchivedBySessionId(sessionId);
    return rec ? toEntry(rec) : null;
  }

  getArchivedSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const rec of sessionStore.listArchived()) {
      for (const h of rec.lineage.history) out.add(h.sessionId);
    }
    return out;
  }

  /**
   * Restore the requested sessionId's archived transcript into
   * `~/.claude/projects/{slug}/{sessionId}.jsonl` so `claude --resume` finds it.
   * Other transcripts in the lineage are left under archive/.
   */
  restoreTranscript(sessionId: string): string | null {
    const rec = sessionStore.getArchivedBySessionId(sessionId);
    const archived = rec?.archive?.transcripts.find(t => t.sessionId === sessionId);
    if (!rec || !archived) return null;
    if (!fs.existsSync(archived.path)) return null;
    // Match Claude CLI's project-dir slug exactly: convert `/`, `\`, `:`, `.` to `-`
    // and keep any leading dash. Do NOT strip leading dashes — `claude --resume`
    // looks in `~/.claude/projects/-Users-.../` and won't find files written to
    // `~/.claude/projects/Users-.../`.
    const projectSlug = rec.cwd.replace(/[\\:/.]/g, '-');
    const destDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
    ensureDir(destDir);
    const destPath = path.join(destDir, `${sessionId}.jsonl`);
    if (fs.existsSync(destPath)) return destPath;
    try {
      // Rewrite sessionId in every line so `claude --resume {sessionId}` finds this file.
      const raw = fs.readFileSync(archived.path, 'utf-8');
      const rewritten = raw.split('\n').map(line => {
        if (!line.trim()) return line;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object') obj.sessionId = sessionId;
          return JSON.stringify(obj);
        } catch {
          return line;
        }
      }).join('\n');
      fs.writeFileSync(destPath, rewritten, 'utf-8');
    } catch {
      return null;
    }
    return destPath;
  }

  /**
   * Unarchive: move the overlord back to the active dir and delete the archived
   * transcript copies. Idempotent.
   */
  remove(sessionId: string): boolean {
    const rec = sessionStore.getArchivedBySessionId(sessionId);
    if (!rec?.archive) return false;
    for (const t of rec.archive.transcripts) {
      try { if (fs.existsSync(t.path)) fs.unlinkSync(t.path); } catch { /* ignore */ }
    }
    // Remove empty per-overlord archive dir.
    const slug = rec.archive.roomId;
    const overlordArchiveDir = path.join(ARCHIVE_BASE, slug, rec.overlordId);
    try { fs.rmdirSync(overlordArchiveDir); } catch { /* not empty or missing — ignore */ }
    sessionStore.unarchive(rec.overlordId);
    return true;
  }

  /**
   * Restore the transcript and move the record back to active, as one step.
   *
   * The unarchive REST route and stateManager's live-pid adoption path both need
   * exactly this pair; keeping it here stops them drifting. Callers still own
   * re-hydrating the live Session (`stateManager.rehydrateFromSessionStore`) —
   * this module must not depend on stateManager.
   *
   * Returns the now-active record, or undefined when the transcript could not be
   * restored (record left archived, so the caller can fall back safely).
   */
  unarchiveForAdoption(sessionId: string): OverlordSession | undefined {
    const rec = sessionStore.getArchivedBySessionId(sessionId);
    if (!rec?.archive) return undefined;
    if (!this.restoreTranscript(sessionId)) return undefined;
    if (!this.remove(sessionId)) return undefined;
    return sessionStore.getByOverlordId(rec.overlordId);
  }

  /**
   * Permanently delete an archived overlord: unlink the archived transcript
   * copies, remove the per-overlord archive dir, and drop the OverlordSession
   * record entirely (index + JSON file + shadow dir). Unlike `remove`
   * (unarchive), the record does NOT survive and the transcript is NOT restored
   * into ~/.claude/projects. Idempotent — returns false if not archived.
   */
  deleteArchive(sessionId: string): boolean {
    const rec = sessionStore.getArchivedBySessionId(sessionId);
    if (!rec?.archive) return false;
    for (const t of rec.archive.transcripts) {
      try { if (fs.existsSync(t.path)) fs.unlinkSync(t.path); } catch { /* ignore */ }
    }
    const slug = rec.archive.roomId;
    const overlordArchiveDir = path.join(ARCHIVE_BASE, slug, rec.overlordId);
    try { fs.rmdirSync(overlordArchiveDir); } catch { /* not empty or missing — ignore */ }
    sessionStore.remove(rec.overlordId);
    return true;
  }
}

export const archiveManager = new ArchiveManager();
