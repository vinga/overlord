import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Pin } from '../types.js';
import { sanitizePins } from './pins.js';

export type RoomLastMode = 'embedded' | 'bridge' | 'plain' | 'raw' | 'note';
export type RoomLastProvider = 'claude' | 'opencode' | 'codex';

export interface RoomConfig {
  prefix: string;
  description: string;
  lastMode?: RoomLastMode;
  lastProvider?: RoomLastProvider;
  /** Room hidden in the office view. Only `true` is stored; absent = visible. */
  hidden?: boolean;
  /** Links pinned to the room. */
  pins?: Pin[];
}

const DEFAULT_CONFIG: RoomConfig = { prefix: '', description: '' };

const VALID_MODES: ReadonlySet<RoomLastMode> = new Set(['embedded', 'bridge', 'plain', 'raw', 'note']);

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

function getRoomConfigPath(cwd: string): string {
  return path.join(roomsDir(), `${cwdToRoomSlug(cwd)}.config.json`);
}

// In-memory cache. Populated lazily on first read; invalidated on local writes
// (writeRoomConfig) and on external file changes (chokidar watcher below).
// `getSnapshot()` reads roomConfig per room every tick — without this cache
// each tick was N×(fs.existsSync + fs.readFileSync + JSON.parse).
const configCache = new Map<string, RoomConfig>();
let slugsCache: string[] | undefined;
let watcher: FSWatcher | undefined;

function ensureWatcher(): void {
  if (watcher) return;
  const dir = roomsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  try {
    watcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    const invalidate = (filePath: string) => {
      const base = path.basename(filePath);
      if (!base.endsWith('.config.json')) return;
      const slug = base.replace(/\.config\.json$/, '');
      // Drop every cwd whose slug matches — slug→cwd is many-to-one in theory,
      // but in practice the cache is keyed by the cwd we read for, so iterate.
      for (const [cwd] of configCache) {
        if (cwdToRoomSlug(cwd) === slug) configCache.delete(cwd);
      }
      slugsCache = undefined;
    };
    watcher.on('add', invalidate);
    watcher.on('change', invalidate);
    watcher.on('unlink', invalidate);
    watcher.on('error', () => { /* ignore */ });
  } catch { /* watcher is best-effort */ }
}

function loadFromDisk(cwd: string): RoomConfig {
  try {
    const p = getRoomConfigPath(cwd);
    if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<RoomConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      prefix: typeof parsed.prefix === 'string' ? parsed.prefix : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      lastMode: typeof parsed.lastMode === 'string' && VALID_MODES.has(parsed.lastMode as RoomLastMode)
        ? (parsed.lastMode as RoomLastMode)
        : undefined,
      lastProvider: parsed.lastProvider === 'opencode' || parsed.lastProvider === 'codex' || parsed.lastProvider === 'claude'
        ? parsed.lastProvider
        : undefined,
      hidden: parsed.hidden === true ? true : undefined,
      pins: sanitizePins(parsed.pins),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function readRoomConfig(cwd: string): RoomConfig {
  ensureWatcher();
  const cached = configCache.get(cwd);
  if (cached) return cached;
  const cfg = loadFromDisk(cwd);
  configCache.set(cwd, cfg);
  return cfg;
}

export function writeRoomConfig(cwd: string, cfg: RoomConfig): void {
  try {
    const p = getRoomConfigPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
    configCache.set(cwd, { ...cfg });
    slugsCache = undefined;
  } catch { /* swallow — config is best-effort */ }
}

/**
 * List slugs for every room that has a config file on disk. Used to surface
 * rooms that have no currently-hydrated sessions so the user can still spawn
 * new sessions in them.
 */
export function listConfiguredRoomSlugs(): string[] {
  ensureWatcher();
  if (slugsCache) return slugsCache;
  const dir = roomsDir();
  try {
    slugsCache = fs.readdirSync(dir)
      .filter(f => f.endsWith('.config.json'))
      .map(f => f.replace(/\.config\.json$/, ''));
  } catch {
    slugsCache = [];
  }
  return slugsCache;
}

export function slugForCwd(cwd: string): string { return cwdToRoomSlug(cwd); }

/** Folder of the room a session belongs to: its `roomCwd` override when it was
 *  moved, else the folder it runs in. Use this, not `cwd`, for anything
 *  room-scoped (grouping, room pins, archive room). */
export function sessionRoomCwd(rec: { cwd: string; roomCwd?: string }): string {
  return rec.roomCwd || rec.cwd;
}

export interface RoomRef { id: string; name: string; cwd: string }

/** Match a user-typed room (id, folder path, or name — case-insensitive) against
 *  the known rooms. An exact id or folder wins over a name; several rooms with
 *  the same name are ambiguous. */
export function matchRoom(rooms: RoomRef[], query: string): { room: RoomRef } | { candidates: RoomRef[] } {
  const q = query.trim();
  const folder = q.length > 1 ? q.replace(/[\\/]+$/, '') : q;
  const exact = rooms.find(r => r.id === q || r.cwd === q || r.cwd === folder);
  if (exact) return { room: exact };
  const lower = q.toLowerCase();
  const byName = rooms.filter(r => r.name.toLowerCase() === lower || r.id.toLowerCase() === lower);
  return byName.length === 1 ? { room: byName[0] } : { candidates: byName };
}
