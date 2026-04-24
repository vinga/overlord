import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type RoomLastMode = 'embedded' | 'bridge' | 'plain' | 'raw';
export type RoomLastProvider = 'claude' | 'opencode';

export interface RoomConfig {
  prefix: string;
  description: string;
  lastMode?: RoomLastMode;
  lastProvider?: RoomLastProvider;
}

const DEFAULT_CONFIG: RoomConfig = { prefix: '', description: '' };

const VALID_MODES: ReadonlySet<RoomLastMode> = new Set(['embedded', 'bridge', 'plain', 'raw']);

function cwdToRoomSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function getRoomConfigPath(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'rooms', `${cwdToRoomSlug(cwd)}.config.json`);
}

export function readRoomConfig(cwd: string): RoomConfig {
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
      lastProvider: parsed.lastProvider === 'opencode' ? 'opencode' : parsed.lastProvider === 'claude' ? 'claude' : undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeRoomConfig(cwd: string, cfg: RoomConfig): void {
  try {
    const p = getRoomConfigPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch { /* swallow — config is best-effort */ }
}
