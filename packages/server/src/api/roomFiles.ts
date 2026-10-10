import * as fs from 'fs';
import { execFile } from 'child_process';
import { join, relative, resolve, sep, isAbsolute } from 'path';
import { looksSecret } from './pathGuard.js';

/**
 * Backing for the room file browser: list a room's files and gate every
 * read/write of one of them.
 *
 * The browser is reachable from a web page, so the rules live here, not in the
 * tree UI — a hand-crafted URL gets the same answer as a click:
 *  - gitignored files are never listed nor opened (that is where .env lives);
 *  - DENY_DIRS and `looksSecret()` hide files even when they are tracked;
 *  - every path is realpath'd and must stay inside the room cwd.
 */

/** Directories never shown, tracked or not. */
export const DENY_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__', '.next', 'target',
]);

export const MAX_LISTED_FILES = 20_000;
export const MAX_WALK_FILES = 5_000;
const MAX_WALK_DEPTH = 8;
export const MAX_ROOM_FILE_BYTES = 2 * 1024 * 1024;
const LIST_CACHE_MS = 10_000;

export type ChangeCode = 'M' | 'A' | 'D' | '?' | 'R';

export interface RoomFileList {
  files: string[];
  /** Uncommitted changes, vs HEAD. */
  changed: Record<string, ChangeCode>;
  /** Branch changes vs the merge-base with `base`, working tree included. Absent on the base branch. */
  prChanged?: Record<string, ChangeCode>;
  /** The ref `prChanged` is measured against, e.g. `origin/main`. */
  base?: string;
  truncated: boolean;
  git: boolean;
}

export type RoomFileVerdict =
  | { ok: true; abs: string }
  | { ok: false; status: number; reason: string };

/** True when a cwd-relative path ('/'-separated) must stay hidden. */
export function isDeniedRel(rel: string): boolean {
  const segs = rel.split('/');
  if (segs.some(s => DENY_DIRS.has(s))) return true;
  return looksSecret(segs.join(sep));
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(res => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      res({ code, stdout: stdout ?? '' });
    });
  });
}

function gitBuf(cwd: string, args: string[]): Promise<{ code: number; stdout: Buffer }> {
  return new Promise(res => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      res({ code, stdout: stdout ?? Buffer.alloc(0) });
    });
  });
}

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return resolve(p); }
}

// ── .gitignore fallback for non-git rooms ───────────────────────────────────

/** Minimal root-.gitignore matcher: globs (`*`, `?`, `**`), dir-only `/`,
 *  anchored leading `/`. Negation (`!`) is ignored — erring towards hiding. */
export function parseGitignore(text: string): (rel: string, isDir: boolean) => boolean {
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = line
      .split('**').map(part => part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'))
      .join('.*');
    const re = new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`);
    rules.push({ re, dirOnly });
  }
  return (rel, isDir) => rules.some(r => (!r.dirOnly || isDir) && r.re.test(rel));
}

function readRootGitignore(cwd: string): (rel: string, isDir: boolean) => boolean {
  try { return parseGitignore(fs.readFileSync(join(cwd, '.gitignore'), 'utf8')); } catch { return () => false; }
}

function walk(cwd: string): { files: string[]; truncated: boolean } {
  const ignored = readRootGitignore(cwd);
  const files: string[] = [];
  let truncated = false;
  const visit = (dirRel: string, depth: number): void => {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(join(cwd, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      // Symlinks are skipped outright: following them could leave the room.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (DENY_DIRS.has(e.name) || ignored(rel, true) || isDeniedRel(rel)) continue;
        visit(rel, depth + 1);
      } else if (e.isFile()) {
        if (ignored(rel, false) || isDeniedRel(rel)) continue;
        if (files.length >= MAX_WALK_FILES) { truncated = true; return; }
        files.push(rel);
      }
      if (truncated) return;
    }
  };
  visit('', 0);
  return { files, truncated };
}

// ── listing ─────────────────────────────────────────────────────────────────

function porcelainCode(xy: string): ChangeCode {
  if (xy === '??') return '?';
  if (xy.includes('D')) return 'D';
  if (xy.includes('R')) return 'R';
  if (xy.includes('A')) return 'A';
  return 'M';
}

/** `git status --porcelain -z` paths are repo-root relative; strip the cwd prefix. */
export function parsePorcelain(out: string, prefix: string): Record<string, ChangeCode> {
  const changed: Record<string, ChangeCode> = {};
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // Rename/copy entries carry the original path as the next NUL field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (prefix && !path.startsWith(prefix)) continue;
    changed[path.slice(prefix.length)] = porcelainCode(xy);
  }
  return changed;
}

/** `git diff --name-status -z` output → path → code. Renames/copies carry
 *  two paths; the new one is the file that exists now. */
export function parseNameStatus(out: string): Record<string, ChangeCode> {
  const changed: Record<string, ChangeCode> = {};
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') {
      const to = parts[i + 2];
      i += 2;
      if (to) changed[to] = 'R';
      continue;
    }
    const path = parts[++i];
    if (!path) continue;
    changed[path] = st[0] === 'A' ? 'A' : st[0] === 'D' ? 'D' : 'M';
  }
  return changed;
}

export interface BaseInfo { ref: string; mergeBase: string }

/** The branch this room's work will merge into, from local refs only — no
 *  fetch, no GitHub. Null when there is no remote base or HEAD is on it. */
export async function resolveBase(cwd: string): Promise<BaseInfo | null> {
  let ref = '';
  const sym = await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0 && sym.stdout.trim()) ref = sym.stdout.trim();
  if (!ref) {
    for (const cand of ['origin/main', 'origin/master']) {
      if ((await git(cwd, ['rev-parse', '--verify', '-q', `${cand}^{commit}`])).code === 0) { ref = cand; break; }
    }
  }
  if (!ref) return null;
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (branch && `origin/${branch}` === ref) return null;
  const mb = await git(cwd, ['merge-base', 'HEAD', ref]);
  const mergeBase = mb.stdout.trim();
  if (mb.code !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase)) return null;
  return { ref, mergeBase };
}

const listCache = new Map<string, { at: number; value: RoomFileList }>();

export function invalidateRoomFiles(cwd: string): void {
  listCache.delete(realOrResolved(cwd));
}

export async function listRoomFiles(cwdRaw: string): Promise<RoomFileList> {
  const cwd = realOrResolved(cwdRaw);
  const hit = listCache.get(cwd);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.value;

  let value: RoomFileList;
  const ls = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (ls.code === 0) {
    const [status, prefixOut] = await Promise.all([
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
      git(cwd, ['rev-parse', '--show-prefix']),
    ]);
    const prefix = prefixOut.code === 0 ? prefixOut.stdout.trim() : '';
    const all = [...new Set(ls.stdout.split('\0').filter(Boolean))].filter(f => !isDeniedRel(f));
    const changed = status.code === 0 ? parsePorcelain(status.stdout, prefix) : {};
    for (const k of Object.keys(changed)) if (isDeniedRel(k)) delete changed[k];
    all.sort();
    value = {
      files: all.slice(0, MAX_LISTED_FILES),
      changed,
      truncated: all.length > MAX_LISTED_FILES,
      git: true,
    };
    const base = await resolveBase(cwd);
    if (base) {
      const diff = await git(cwd, ['diff', '-z', '--name-status', '-M', '--relative', base.mergeBase, '--']);
      if (diff.code === 0) {
        const prChanged = parseNameStatus(diff.stdout);
        // Untracked files are part of the branch's work too, but not in `git diff`.
        for (const [k, code] of Object.entries(changed)) if (code === '?' && !prChanged[k]) prChanged[k] = 'A';
        for (const k of Object.keys(prChanged)) if (isDeniedRel(k)) delete prChanged[k];
        value.prChanged = prChanged;
        value.base = base.ref;
      }
    }
  } else {
    const w = walk(cwd);
    w.files.sort();
    value = { files: w.files, changed: {}, truncated: w.truncated, git: false };
  }
  listCache.set(cwd, { at: Date.now(), value });
  return value;
}

// ── per-file gate ───────────────────────────────────────────────────────────

/** Resolve a cwd-relative path to an existing regular file the browser may
 *  read or write. Same rules as the listing, checked independently. */
export async function checkRoomFile(cwdRaw: string, rel: unknown): Promise<RoomFileVerdict> {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel)) {
    return { ok: false, status: 400, reason: 'relative path required' };
  }
  const cwd = realOrResolved(cwdRaw);
  const requested = resolve(cwd, rel);
  const inside = (p: string) => p.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep);
  // Boundary before existence: a 404/403 split outside the room would let a
  // caller probe which files exist there.
  if (!inside(requested)) return { ok: false, status: 403, reason: 'path is outside the room' };
  let abs: string;
  try { abs = fs.realpathSync(requested); } catch { return { ok: false, status: 404, reason: 'not found' }; }
  if (!inside(abs)) return { ok: false, status: 403, reason: 'path is outside the room' };

  // Check both the name asked for and the file it resolves to — a symlink
  // called notes.txt pointing at .env is still .env.
  const relReq = relative(cwd, requested).split(sep).join('/');
  const relAbs = relative(cwd, abs).split(sep).join('/');
  if (isDeniedRel(relReq) || isDeniedRel(relAbs)) return { ok: false, status: 403, reason: 'file is hidden from the browser' };

  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { ok: false, status: 404, reason: 'not found' }; }
  if (!st.isFile()) return { ok: false, status: 400, reason: 'not a file' };

  const ign = await git(cwd, ['check-ignore', '-q', '--', relReq, relAbs]);
  if (ign.code === 0) return { ok: false, status: 403, reason: 'file is gitignored' };
  if (ign.code === 128) {
    // Not a git repo — fall back to the root .gitignore, every ancestor dir included.
    const ignored = readRootGitignore(cwd);
    for (const r of [relReq, relAbs]) {
      const segs = r.split('/');
      for (let i = 1; i <= segs.length; i++) {
        if (ignored(segs.slice(0, i).join('/'), i < segs.length)) {
          return { ok: false, status: 403, reason: 'file is gitignored' };
        }
      }
    }
  }
  return { ok: true, abs };
}

/** A text file the editor can show: not too large, no NUL bytes. */
export function readRoomFileText(abs: string): { ok: true; content: string } | { ok: false; status: number; reason: string } {
  const size = fs.statSync(abs).size;
  if (size > MAX_ROOM_FILE_BYTES) return { ok: false, status: 413, reason: 'file too large' };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, status: 415, reason: 'binary file' };
  return { ok: true, content: buf.toString('utf8') };
}

export function validateRoomFileContent(content: unknown): { ok: true } | { ok: false; status: number; reason: string } {
  if (typeof content !== 'string') return { ok: false, status: 400, reason: 'content required' };
  if (Buffer.byteLength(content, 'utf8') > MAX_ROOM_FILE_BYTES) return { ok: false, status: 413, reason: 'content too large' };
  if (content.includes('\0')) return { ok: false, status: 415, reason: 'binary content' };
  return { ok: true };
}

// ── diff ────────────────────────────────────────────────────────────────────

export type DiffScope = 'head' | 'pr';

export type RoomFileDiff =
  | { ok: true; original: string; modified: string; originalMissing: boolean; modifiedMissing: boolean; base: string }
  | { ok: false; status: number; reason: string };

function textOrError(buf: Buffer): { ok: true; text: string } | { ok: false; status: number; reason: string } {
  if (buf.length > MAX_ROOM_FILE_BYTES) return { ok: false, status: 413, reason: 'file too large' };
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, status: 415, reason: 'binary file' };
  return { ok: true, text: buf.toString('utf8') };
}

/** Both sides of one file's diff. The revision comes from `scope`, never the
 *  request; a file deleted on disk only gets the path-string checks, since
 *  realpath/check-ignore need it to exist. */
export async function readRoomFileDiff(cwdRaw: string, rel: unknown, scope: DiffScope): Promise<RoomFileDiff> {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel)) {
    return { ok: false, status: 400, reason: 'relative path required' };
  }
  const cwd = realOrResolved(cwdRaw);
  const requested = resolve(cwd, rel);
  if (!requested.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) return { ok: false, status: 403, reason: 'path is outside the room' };
  const relReq = relative(cwd, requested).split(sep).join('/');
  if (isDeniedRel(relReq)) return { ok: false, status: 403, reason: 'file is hidden from the browser' };

  let modified = '';
  let modifiedMissing = true;
  if (fs.existsSync(requested)) {
    const verdict = await checkRoomFile(cwd, relReq);
    if (!verdict.ok) return verdict;
    const read = readRoomFileText(verdict.abs);
    if (!read.ok) return read;
    modified = read.content;
    modifiedMissing = false;
  }

  let rev = 'HEAD';
  let baseLabel = 'HEAD';
  if (scope === 'pr') {
    const base = await resolveBase(cwd);
    if (!base) return { ok: false, status: 409, reason: 'no base branch to compare with' };
    rev = base.mergeBase;
    baseLabel = base.ref;
  }
  const shown = await gitBuf(cwd, ['show', `${rev}:./${relReq}`]);
  let original = '';
  const originalMissing = shown.code !== 0;
  if (!originalMissing) {
    const t = textOrError(shown.stdout);
    if (!t.ok) return t;
    original = t.text;
  }
  if (originalMissing && modifiedMissing) return { ok: false, status: 404, reason: 'not found' };
  return { ok: true, original, modified, originalMissing, modifiedMissing, base: baseLabel };
}
