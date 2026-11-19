import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Starred user messages per overlord lineage, keyed by message timestamp.
 *  `~/.claude/overlord/questions/<overlordId>.json` = `{ starred: string[] }`. */

function dir(): string {
  // $HOME first so tests can stub it (os.homedir() ignores the env on macOS).
  return path.join(process.env.HOME ?? os.homedir(), '.claude', 'overlord', 'questions');
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function file(overlordId: string): string {
  return path.join(dir(), `${overlordId}.json`);
}

export function readStars(overlordId: string): string[] {
  if (!isSafeId(overlordId)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file(overlordId), 'utf8')) as { starred?: unknown };
    return Array.isArray(parsed.starred) ? parsed.starred.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** Set or clear one star. Returns the new list. */
export function setStar(overlordId: string, messageId: string, starred: boolean): string[] {
  if (!isSafeId(overlordId)) return [];
  const current = readStars(overlordId);
  const next = starred
    ? (current.includes(messageId) ? current : [...current, messageId])
    : current.filter(s => s !== messageId);
  if (next.length === current.length && next.every((s, i) => s === current[i])) return current;
  fs.mkdirSync(dir(), { recursive: true });
  if (next.length === 0) {
    try { fs.unlinkSync(file(overlordId)); } catch { /* already gone */ }
  } else {
    const tmp = `${file(overlordId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ starred: next }), 'utf8');
    fs.renameSync(tmp, file(overlordId));
  }
  return next;
}

export function deleteStars(overlordId: string): void {
  if (!isSafeId(overlordId)) return;
  try { fs.unlinkSync(file(overlordId)); } catch { /* missing is fine */ }
}
