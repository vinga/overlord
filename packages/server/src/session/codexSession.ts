import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StateManager } from './stateManager.js';

/**
 * Every Codex session Overlord launches runs with full access: no sandbox, no
 * approval prompts. Passed explicitly so a spawn doesn't depend on the user's
 * `~/.codex/config.toml`. A ChatGPT workspace policy can still override it.
 */
const CODEX_FULL_ACCESS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

export function buildCodexSpawnArgs(): string[] {
  return [CODEX_FULL_ACCESS_FLAG];
}

/** Resume a specific Codex session by its id. `--last` is only a fallback: it
 *  picks the newest session in the cwd, which is the wrong conversation once
 *  two Codex workers share a directory. */
export function buildCodexResumeArgs(providerSessionId?: string): string[] {
  const target = providerSessionId && /^[0-9a-f-]{8,64}$/i.test(providerSessionId) ? providerSessionId : '--last';
  return ['resume', target, CODEX_FULL_ACCESS_FLAG];
}

/** Shell form for external / bridged terminal windows. */
export function buildCodexResumeCommand(providerSessionId?: string): string {
  return ['codex', ...buildCodexResumeArgs(providerSessionId)].join(' ');
}

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
function recentDayDirs(root: string, dayBreadth = 2): string[] {
  const descend = (dir: string, depth: number): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const keep = depth === 0 ? dayBreadth : 2;
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse().slice(0, keep);
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
  return scanRollouts(rollout => normalize(rollout.cwd) === normalize(cwd), startedAfterMs);
}

/**
 * The rollout belonging to a known codex session id, regardless of age. Used to
 * re-link a session across a server restart, where "newest in this cwd" would
 * happily claim a rollout that belongs to some other codex worker.
 */
export function findCodexRolloutBySessionId(codexSessionId: string): CodexRollout | null {
  return scanRollouts(rollout => rollout.sessionId === codexSessionId, 0, 8);
}

function scanRollouts(
  match: (meta: { sessionId: string; cwd: string }) => boolean,
  startedAfterMs: number,
  dayBreadth = 2,
): CodexRollout | null {
  const candidates: { file: string; mtime: number }[] = [];
  for (const dir of recentDayDirs(sessionsRoot(), dayBreadth)) {
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
    if (meta && match(meta)) {
      return { sessionId: meta.sessionId, transcriptPath: file };
    }
  }
  return null;
}

/**
 * Codex writes its rollout jsonl only once the session is under way, so poll
 * for it after spawn and attach it to the session. Without this the worker is
 * terminal-only — no conversation, no transcript-driven state.
 */
export function scheduleCodexTranscriptCapture(
  stateManager: StateManager,
  sessionId: string,
  cwd: string,
  startedAfterMs: number,
  // Resume: `codex resume` continues into a *new* rollout file, so the path
  // already on the session is stale and must be replaced once the new one
  // appears. Fresh spawns stop as soon as they have any path.
  opts: { replaceExisting?: boolean } = {},
): void {
  // Codex only writes the rollout on the first turn, which may be minutes after
  // spawn (or never, if the user just looks at the TUI). Poll fast at first,
  // then back off to 10s and keep going until the session is linked or closed.
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    const session = stateManager.getSession(sessionId);
    if (!session || session.state === 'closed') return;
    if (session.transcriptPath && !opts.replaceExisting) return;
    const found = findLatestCodexRollout(cwd, startedAfterMs);
    // Two codex workers in one directory both see the same "newest rollout".
    // Whoever links first owns it; the other keeps polling for its own.
    const claimedByOther = found && stateManager.getAllSessionIds().some(id =>
      id !== sessionId && stateManager.getSession(id)?.transcriptPath === found.transcriptPath,
    );
    if (found && !claimedByOther) {
      stateManager.attachProviderTranscript(sessionId, found.transcriptPath, found.sessionId);
      console.log(`[codex] linked ${sessionId.slice(0, 18)} → ${found.transcriptPath}`);
      return;
    }
    setTimeout(tick, attempts < 30 ? 1000 : 10_000).unref?.();
  };
  setTimeout(tick, 1000).unref?.();
}
