import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { type FSWatcher } from 'chokidar';
import type { PrInfo } from './prCache.js';

export interface PrHistoryEntry {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  branch: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

const MAX_ENTRIES = 10;

function cwdToRoomSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function roomsDir(): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'rooms');
}

function historyPath(cwd: string): string {
  return path.join(roomsDir(), `${cwdToRoomSlug(cwd)}.pr-history.json`);
}

interface FileShape { entries: PrHistoryEntry[] }

export class PrHistoryStore {
  private cache = new Map<string, PrHistoryEntry[]>();
  private watcher: FSWatcher | undefined;

  private ensureWatcher(): void {
    if (this.watcher) return;
    const dir = roomsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    try {
      this.watcher = chokidar.watch(dir, {
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      });
      const invalidate = (filePath: string) => {
        const base = path.basename(filePath);
        if (!base.endsWith('.pr-history.json')) return;
        const slug = base.replace(/\.pr-history\.json$/, '');
        for (const [cwd] of this.cache) {
          if (cwdToRoomSlug(cwd) === slug) this.cache.delete(cwd);
        }
      };
      this.watcher.on('add', invalidate);
      this.watcher.on('change', invalidate);
      this.watcher.on('unlink', invalidate);
      this.watcher.on('error', () => { /* ignore */ });
    } catch { /* best-effort */ }
  }

  private loadFromDisk(cwd: string): PrHistoryEntry[] {
    try {
      const p = historyPath(cwd);
      if (!fs.existsSync(p)) return [];
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<FileShape>;
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isValidEntry);
    } catch {
      return [];
    }
  }

  private persist(cwd: string, entries: PrHistoryEntry[]): void {
    try {
      const p = historyPath(cwd);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // Atomic write: tmp + rename so readers never see a partial file.
      const tmp = `${p}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), 'utf-8');
      fs.renameSync(tmp, p);
    } catch { /* best-effort */ }
  }

  list(cwd: string): PrHistoryEntry[] {
    this.ensureWatcher();
    const cached = this.cache.get(cwd);
    if (cached) return cached;
    const fresh = this.loadFromDisk(cwd);
    this.cache.set(cwd, fresh);
    return fresh;
  }

  record(cwd: string, branch: string, pr: PrInfo): void {
    this.ensureWatcher();
    const now = Date.now();
    const current = this.cache.get(cwd) ?? this.loadFromDisk(cwd);
    const existingIdx = current.findIndex(e => e.number === pr.number);
    let next: PrHistoryEntry[];
    if (existingIdx >= 0) {
      const existing = current[existingIdx];
      // Skip persistence when nothing meaningful changed — avoids disk writes
      // on every prCache poll hit. State, draft, title, url, branch are the
      // observable fields; lastSeenAt is internal bookkeeping.
      const sameContent =
        existing.state === pr.state
        && existing.isDraft === pr.isDraft
        && existing.title === pr.title
        && existing.url === pr.url
        && existing.branch === branch;
      if (sameContent) {
        // Update lastSeenAt in memory only; don't persist (saves disk churn).
        existing.lastSeenAt = now;
        return;
      }
      next = current.slice();
      next[existingIdx] = {
        ...existing,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        branch,
        lastSeenAt: now,
      };
    } else {
      const entry: PrHistoryEntry = {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        branch,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      next = [entry, ...current];
    }
    // Sort by lastSeenAt desc, cap to MAX_ENTRIES.
    next.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
    this.cache.set(cwd, next);
    this.persist(cwd, next);
  }
}

function isValidEntry(e: unknown): e is PrHistoryEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return typeof r.number === 'number'
    && typeof r.url === 'string'
    && typeof r.title === 'string'
    && typeof r.state === 'string'
    && typeof r.isDraft === 'boolean'
    && typeof r.branch === 'string'
    && typeof r.firstSeenAt === 'number'
    && typeof r.lastSeenAt === 'number';
}
