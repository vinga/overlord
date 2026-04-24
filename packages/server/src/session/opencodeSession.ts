import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

function opencodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildOpencodeResumeArgs(providerSessionId?: string): string[] {
  return providerSessionId ? ['--session', providerSessionId] : ['--continue'];
}

export function findLatestOpencodeSessionId(cwd: string, createdAfterMs: number): string | undefined {
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) return undefined;
  try {
    const query = [
      'select id',
      'from session',
      `where directory = '${sqlEscape(cwd)}'`,
      `and time_created >= ${Math.max(0, Math.floor(createdAfterMs))}`,
      'order by time_created desc',
      'limit 1;',
    ].join(' ');
    const out = execFileSync('sqlite3', [dbPath, query], {
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
