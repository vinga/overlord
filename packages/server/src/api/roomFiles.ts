import * as fs from 'fs';
import * as os from 'os';
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
 *  - every path is realpath'd and must stay inside the room cwd — or inside
 *    the target of a room symlink to a directory (one hop, see resolveLinkedDir).
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

function walk(cwd: string, maxFiles = MAX_WALK_FILES): { files: string[]; links: string[]; truncated: boolean } {
  const ignored = readRootGitignore(cwd);
  const files: string[] = [];
  const links: string[] = [];
  let truncated = false;
  const visit = (dirRel: string, depth: number): void => {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(join(cwd, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      // Symlinks are never walked through here — the caller decides which are
      // followed (resolveLinkedDir), one hop only.
      if (e.isSymbolicLink()) {
        if (!ignored(rel, true) && !isDeniedRel(rel)) links.push(rel);
        continue;
      }
      if (e.isDirectory()) {
        if (DENY_DIRS.has(e.name) || ignored(rel, true) || isDeniedRel(rel)) continue;
        visit(rel, depth + 1);
      } else if (e.isFile()) {
        if (ignored(rel, false) || isDeniedRel(rel)) continue;
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push(rel);
      }
      if (truncated) return;
    }
  };
  visit('', 0);
  return { files, links, truncated };
}

// ── symlinked directories ───────────────────────────────────────────────────

/** Symlinked directories followed per room. More than this is not a link, it is a farm. */
const MAX_LINKED_DIRS = 20;

const isUnder = (p: string, root: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The realpath a room symlink at `rel` may be followed to, or null. Only a
 *  directory outside the room qualifies, and never one that would widen the
 *  browser to $HOME or beyond: not `/`, not $HOME or its ancestors, not an
 *  ancestor of the room, not a secrets dir (`~/.ssh`). */
export function resolveLinkedDir(cwd: string, rel: string): string | null {
  if (isDeniedRel(rel)) return null;
  let target: string;
  try { target = fs.realpathSync(join(cwd, rel)); } catch { return null; }
  try { if (!fs.statSync(target).isDirectory()) return null; } catch { return null; }
  const home = realOrResolved(os.homedir());
  if (target === cwd || isUnder(target, cwd)) return null;   // already listed
  if (isUnder(cwd, target)) return null;                     // ancestor of the room
  if (target === home || isUnder(home, target)) return null; // $HOME, its ancestors, `/`
  if (looksSecret(target)) return null;
  return target;
}

/** Room entries that are symlinks. git lists a symlink as a plain entry and
 *  never descends into it, so lstat tells them apart. */
async function symlinkEntries(cwd: string, rels: string[]): Promise<string[]> {
  const hits = await Promise.all(rels.map(rel =>
    fs.promises.lstat(join(cwd, rel)).then(s => (s.isSymbolicLink() ? rel : null), () => null)));
  return hits.filter((r): r is string => r !== null);
}

/** Files of a followed link, relative to its target. Uses the target's own git
 *  (its .gitignore applies), else the walk. Nested symlinks are dropped: one hop. */
async function listLinkedTarget(target: string, budget: number): Promise<{ files: string[]; truncated: boolean }> {
  const ls = await git(target, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (ls.code !== 0) {
    const w = walk(target, budget);
    return { files: w.files, truncated: w.truncated };
  }
  const all = [...new Set(ls.stdout.split('\0').filter(Boolean))].filter(f => !isDeniedRel(f));
  const nested = new Set(await symlinkEntries(target, all));
  const files = all.filter(f => !nested.has(f));
  return { files: files.slice(0, budget), truncated: files.length > budget };
}

/** Append the files of every followed link under `<link>/`, within `cap`
 *  total. Room files come first, so a huge target can't crowd them out. */
async function mergeLinkedFiles(cwd: string, links: string[], files: string[], cap: number): Promise<{ files: string[]; truncated: boolean; links: string[] }> {
  const followed: string[] = [];
  const out = [...files];
  let truncated = false;
  for (const rel of links.slice(0, MAX_LINKED_DIRS)) {
    const target = resolveLinkedDir(cwd, rel);
    if (!target) continue;
    followed.push(rel);
    const budget = cap - out.length;
    if (budget <= 0) { truncated = true; break; }
    const r = await listLinkedTarget(target, budget);
    for (const f of r.files) {
      const full = `${rel}/${f}`;
      if (!isDeniedRel(full)) out.push(full);
    }
    if (r.truncated) truncated = true;
  }
  return { files: out, truncated, links: followed };
}

/** The shortest cwd-relative prefix of `rel` that is a symlink, or null. */
function firstSymlinkPrefix(cwd: string, rel: string): string | null {
  const segs = rel.split('/');
  for (let i = 1; i < segs.length; i++) {
    const prefix = segs.slice(0, i).join('/');
    try { if (fs.lstatSync(join(cwd, prefix)).isSymbolicLink()) return prefix; } catch { return null; }
  }
  return null;
}

/** True when `rels` (relative to `root`) are ignored there: git check-ignore in
 *  a repo, the root .gitignore with every ancestor dir otherwise. */
async function ignoredIn(root: string, rels: string[]): Promise<boolean> {
  const ign = await git(root, ['check-ignore', '-q', '--', ...rels]);
  if (ign.code === 0) return true;
  if (ign.code !== 128) return false;
  const ignored = readRootGitignore(root);
  for (const r of rels) {
    const segs = r.split('/');
    for (let i = 1; i <= segs.length; i++) {
      if (ignored(segs.slice(0, i).join('/'), i < segs.length)) return true;
    }
  }
  return false;
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
    const links = await symlinkEntries(cwd, all);
    const linkSet = new Set(links);
    const own = all.filter(f => !linkSet.has(f)).sort();
    const changed = status.code === 0 ? parsePorcelain(status.stdout, prefix) : {};
    for (const k of Object.keys(changed)) if (isDeniedRel(k) || linkSet.has(k)) delete changed[k];
    const merged = await mergeLinkedFiles(cwd, links, own.slice(0, MAX_LISTED_FILES), MAX_LISTED_FILES);
    value = {
      files: merged.files.sort(),
      changed,
      truncated: own.length > MAX_LISTED_FILES || merged.truncated,
      git: true,
    };
    const base = await resolveBase(cwd);
    if (base) {
      const diff = await git(cwd, ['diff', '-z', '--name-status', '-M', '--relative', base.mergeBase, '--']);
      if (diff.code === 0) {
        const prChanged = parseNameStatus(diff.stdout);
        // Untracked files are part of the branch's work too, but not in `git diff`.
        for (const [k, code] of Object.entries(changed)) if (code === '?' && !prChanged[k]) prChanged[k] = 'A';
        for (const k of Object.keys(prChanged)) if (isDeniedRel(k) || linkSet.has(k)) delete prChanged[k];
        value.prChanged = prChanged;
        value.base = base.ref;
      }
    }
  } else {
    const w = walk(cwd);
    const merged = await mergeLinkedFiles(cwd, w.links, w.files, MAX_WALK_FILES);
    value = { files: merged.files.sort(), changed: {}, truncated: w.truncated || merged.truncated, git: false };
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
  const relReq = relative(cwd, requested).split(sep).join('/');
  let abs: string;
  try { abs = fs.realpathSync(requested); } catch {
    // Same no-probe rule through a link the browser does not follow (to $HOME, say).
    const link = firstSymlinkPrefix(cwd, relReq);
    if (link) {
      const linkReal = realOrResolved(join(cwd, link));
      if (!isUnder(linkReal, cwd) && !resolveLinkedDir(cwd, link)) return { ok: false, status: 403, reason: 'path is outside the room' };
    }
    return { ok: false, status: 404, reason: 'not found' };
  }

  // Outside the room is allowed only through a followed directory link: the
  // first symlinked segment of the path, accepted by resolveLinkedDir, with the
  // file's realpath still under that link's target (one hop).
  let root = cwd;
  let linkRel: string | null = null;
  if (!inside(abs)) {
    linkRel = firstSymlinkPrefix(cwd, relReq);
    const target = linkRel ? resolveLinkedDir(cwd, linkRel) : null;
    if (!target || !isUnder(abs, target)) return { ok: false, status: 403, reason: 'path is outside the room' };
    root = target;
  }

  // Check both the name asked for and the file it resolves to — a symlink
  // called notes.txt pointing at .env is still .env.
  const relAbs = relative(root, abs).split(sep).join('/');
  if (isDeniedRel(relReq) || isDeniedRel(relAbs)) return { ok: false, status: 403, reason: 'file is hidden from the browser' };

  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { ok: false, status: 404, reason: 'not found' }; }
  if (!st.isFile()) return { ok: false, status: 400, reason: 'not a file' };

  // A linked file answers to both: the room's ignore rules for the link, the
  // target's own for the file.
  const ignored = linkRel
    ? await ignoredIn(cwd, [linkRel]) || await ignoredIn(root, [relAbs])
    : await ignoredIn(cwd, [relReq, relAbs]);
  if (ignored) return { ok: false, status: 403, reason: 'file is gitignored' };
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
