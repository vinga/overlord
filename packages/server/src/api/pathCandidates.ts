import * as fs from 'fs';
import * as os from 'os';
import { isAbsolute, join, resolve, sep } from 'path';
import { resolveAllowedPath } from './pathGuard.js';

/**
 * Where a path mentioned in the chat feed could live. Absolute and `~/` paths
 * have one answer; a relative one is tried against every plausible base — the
 * room, its git root, $HOME, then the other rooms — and every hit is kept,
 * because guessing the wrong one silently is worse than showing a choice.
 */

export interface PathCandidate {
  path: string;
  kind: 'file' | 'dir';
  /** Which base produced it: 'absolute' | 'home' | 'room' | 'git root' | 'room: <name>'. */
  base: string;
  /** Passes the strict file guard, so the inline editor can open it and a
   *  preview is read. Reveal needs no guard. */
  openable: boolean;
  /** The known room this sits in (longest cwd prefix), for "Show in Files". */
  room?: { cwd: string; rel: string; inTree?: boolean; reason?: string };
  /** First lines of a small text file; absent for dirs, binaries, non-openable. */
  preview?: string;
  size?: number;
}

export interface ResolveBases {
  cwd?: string;
  gitRoot?: string | null;
  otherRooms?: string[];
  home?: string;
}

const MAX_CANDIDATES = 8;
const PREVIEW_BYTES = 4096;
const PREVIEW_LINES = 14;
const PREVIEW_MAX_CANDIDATES = 3;

/** Head of a text file, or undefined for binaries (NUL byte in the first 4 KB). */
export function readPreview(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(PREVIEW_BYTES);
    const n = fs.readSync(fd, buf, 0, PREVIEW_BYTES, 0);
    const chunk = buf.subarray(0, n);
    if (chunk.includes(0)) return undefined;
    const lines = chunk.toString('utf8').split('\n');
    // A chunk cut mid-line loses its partial tail rather than show half a line.
    if (n === PREVIEW_BYTES && lines.length > 1) lines.pop();
    return lines.slice(0, PREVIEW_LINES).join('\n');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function roomOf(path: string, rooms: string[]): { cwd: string; rel: string } | undefined {
  let best: { cwd: string; root: string } | undefined;
  for (const cwd of rooms) {
    const root = cwd.replace(/[\\/]+$/, '');
    if (path.startsWith(root + sep) && (!best || root.length > best.root.length)) best = { cwd, root };
  }
  if (!best) return undefined;
  return { cwd: best.cwd, rel: path.slice(best.root.length + 1).split(sep).join('/') };
}

function baseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

export function resolvePathCandidates(raw: string, bases: ResolveBases = {}): PathCandidate[] {
  const input = raw.trim();
  if (!input) return [];
  const home = bases.home ?? os.homedir();
  const tries: Array<{ path: string; base: string }> = [];
  if (input === '~' || input.startsWith('~/')) {
    tries.push({ path: join(home, input.slice(1)), base: 'home' });
  } else if (isAbsolute(input)) {
    tries.push({ path: input, base: 'absolute' });
  } else {
    if (bases.cwd) tries.push({ path: resolve(bases.cwd, input), base: 'room' });
    if (bases.gitRoot) tries.push({ path: resolve(bases.gitRoot, input), base: 'git root' });
    tries.push({ path: resolve(home, input), base: 'home' });
    for (const room of bases.otherRooms ?? []) {
      if (room === bases.cwd) continue;
      tries.push({ path: resolve(room, input), base: `room: ${baseName(room)}` });
    }
  }
  const seen = new Set<string>();
  const out: PathCandidate[] = [];
  for (const t of tries) {
    if (out.length >= MAX_CANDIDATES) break;
    let real: string;
    let stat: fs.Stats;
    try {
      real = fs.realpathSync(t.path);
      stat = fs.statSync(real);
    } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    // Existence is reported anywhere — Reveal only selects it in Finder. Reading
    // (Open, preview) stays behind the strict guard.
    const openable = stat.isFile() && resolveAllowedPath(t.path).ok;
    const candidate: PathCandidate = { path: t.path, kind: stat.isDirectory() ? 'dir' : 'file', base: t.base, openable };
    const room = roomOf(t.path, [...(bases.cwd ? [bases.cwd] : []), ...(bases.otherRooms ?? [])]);
    if (room) candidate.room = room;
    if (stat.isFile()) candidate.size = stat.size;
    if (openable && out.length < PREVIEW_MAX_CANDIDATES) {
      const preview = readPreview(real);
      if (preview !== undefined) candidate.preview = preview;
    }
    out.push(candidate);
  }
  return out;
}
