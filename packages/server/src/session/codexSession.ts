import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Codex writes one rollout jsonl per session under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`. Its first line is a
 * `session_meta` record carrying the codex session id + cwd.
 *
 * Overlord spawns `codex` as a plain PTY (the CLI has no name-marker flag), so
 * the only way to link the spawned process to its transcript is to pick the
 * newest rollout in the same cwd written after the spawn. Same trick as the
 * opencode session-id capture.
 */
export interface CodexRollout {
  sessionId: string;
  transcriptPath: string;
}

function sessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Newest day directories (`YYYY/MM/DD`) — a spawn lands in today's; the
 *  second-newest branch at each level survives a midnight/month rollover. */
function recentDayDirs(root: string): string[] {
  const descend = (dir: string, depth: number): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, 2);
    if (depth === 0) return dirs.map(d => path.join(dir, d));
    return dirs.flatMap(d => descend(path.join(dir, d), depth - 1));
  };
  return descend(root, 2);
}

/** First line of the file, read in chunks — codex's `session_meta` record is
 *  well over 16KB (it embeds the base instructions), so a fixed-size head read
 *  truncates it mid-JSON. Capped at 1MB. */
function readFirstLine(filePath: string): string | null {
  const CHUNK = 64 * 1024;
  const MAX = 1024 * 1024;
  const fd = fs.openSync(filePath, 'r');
  try {
    let acc = '';
    let offset = 0;
    while (offset < MAX) {
      const buf = Buffer.alloc(CHUNK);
      const read = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (read <= 0) break;
      offset += read;
      acc += buf.toString('utf-8', 0, read);
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
    }
    return acc.length > 0 ? acc : null;
  } finally {
    fs.closeSync(fd);
  }
}

function readMeta(filePath: string): { sessionId: string; cwd: string } | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine || !firstLine.trim()) return null;
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
    if (parsed.type !== 'session_meta' || !parsed.payload?.id || !parsed.payload.cwd) return null;
    return { sessionId: parsed.payload.id, cwd: parsed.payload.cwd };
  } catch {
    return null;
  }
}

/**
 * Newest codex rollout for `cwd` written after `startedAfterMs`. Returns null
 * while codex is still booting — the rollout appears once the session starts,
 * so callers poll.
 */
export function findLatestCodexRollout(cwd: string, startedAfterMs: number): CodexRollout | null {
  const wanted = normalize(cwd);
  const candidates: { file: string; mtime: number }[] = [];
  for (const dir of recentDayDirs(sessionsRoot())) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < startedAfterMs) continue;
        candidates.push({ file, mtime: stat.mtimeMs });
      } catch {
        // vanished mid-scan
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    const meta = readMeta(file);
    if (meta && normalize(meta.cwd) === wanted) {
      return { sessionId: meta.sessionId, transcriptPath: file };
    }
  }
  return null;
}
