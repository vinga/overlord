import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ArchiveEntry {
  sessionId: string;
  roomId: string;
  cwd: string;
  name: string;
  archivedAt: string;
  transcriptPath: string;
  pid: number;
  provider?: string;
  sessionType?: string;
  startedAt?: number;
  color?: string;
  gitBranch?: string;
  pullRequest?: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
  };
  lastMessage?: string;
  lastActivity?: string;
  model?: string;
}

const ARCHIVE_BASE = path.join(os.homedir(), '.claude', 'overlord', 'archive');
const INDEX_FILE = path.join(ARCHIVE_BASE, 'index.json');

export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[\\:/]/g, '-').replace(/^-+/, '');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class ArchiveManager {
  private entries: ArchiveEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(INDEX_FILE)) { this.entries = []; return; }
      const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    ensureDir(ARCHIVE_BASE);
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  isArchived(sessionId: string): boolean {
    return this.entries.some(e => e.sessionId === sessionId);
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
    pullRequest?: ArchiveEntry['pullRequest'];
    lastMessage?: string;
    lastActivity?: string;
    model?: string;
  }): ArchiveEntry | null {
    const existing = this.entries.find(e => e.sessionId === params.sessionId);
    if (existing) return existing;

    const slug = cwdToSlug(params.cwd);
    const destDir = path.join(ARCHIVE_BASE, slug);
    ensureDir(destDir);
    const destPath = path.join(destDir, `${params.sessionId}.jsonl`);

    if (!params.sourceTranscriptPath || !fs.existsSync(params.sourceTranscriptPath)) {
      return null;
    }
    try {
      fs.copyFileSync(params.sourceTranscriptPath, destPath);
    } catch {
      return null;
    }

    const entry: ArchiveEntry = {
      sessionId: params.sessionId,
      roomId: slug,
      cwd: params.cwd,
      name: params.name,
      archivedAt: new Date().toISOString(),
      transcriptPath: destPath,
      pid: params.pid,
      provider: params.provider,
      sessionType: params.sessionType,
      startedAt: params.startedAt,
      color: params.color,
      gitBranch: params.gitBranch,
      pullRequest: params.pullRequest,
      lastMessage: params.lastMessage,
      lastActivity: params.lastActivity,
      model: params.model,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  list(): ArchiveEntry[] {
    return [...this.entries].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  listByRoom(roomId: string): ArchiveEntry[] {
    return this.entries
      .filter(e => e.roomId === roomId)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  get(sessionId: string): ArchiveEntry | null {
    return this.entries.find(e => e.sessionId === sessionId) ?? null;
  }

  getArchivedSessionIds(): Set<string> {
    return new Set(this.entries.map(e => e.sessionId));
  }

  /**
   * Restore an archived transcript back into ~/.claude/projects/{slug}/{sessionId}.jsonl
   * so Claude CLI's `--resume` can find it. Does NOT touch the archive index.
   * Returns the destination path, or null on failure.
   */
  restoreTranscript(sessionId: string): string | null {
    const entry = this.get(sessionId);
    if (!entry) return null;
    if (!fs.existsSync(entry.transcriptPath)) return null;
    const projectSlug = entry.cwd.replace(/[\\:/]/g, '-').replace(/^-+/, '');
    const destDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
    ensureDir(destDir);
    const destPath = path.join(destDir, `${sessionId}.jsonl`);
    if (fs.existsSync(destPath)) return destPath;
    try {
      fs.copyFileSync(entry.transcriptPath, destPath);
    } catch {
      return null;
    }
    return destPath;
  }

  /**
   * Remove an entry from the archive index and delete its transcript file.
   * Idempotent — returns false if the entry wasn't present.
   */
  remove(sessionId: string): boolean {
    const idx = this.entries.findIndex(e => e.sessionId === sessionId);
    if (idx === -1) return false;
    const entry = this.entries[idx];
    this.entries.splice(idx, 1);
    this.save();
    try {
      if (fs.existsSync(entry.transcriptPath)) fs.unlinkSync(entry.transcriptPath);
    } catch { /* ignore */ }
    return true;
  }
}

export const archiveManager = new ArchiveManager();
