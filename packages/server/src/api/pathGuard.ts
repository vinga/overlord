import * as fs from 'fs';
import * as os from 'os';
import { resolve, dirname, basename, extname, sep } from 'path';

/**
 * Filesystem scoping for every API route that takes a path from the request.
 *
 * Two rules, both required:
 *  1. the realpath-resolved target must sit under an allowed root (room cwds,
 *     ~/.claude, the temp dir, OVERLORD_EXTRA_ROOTS);
 *  2. it must not look like a secret, even inside an allowed root — room cwds
 *     routinely contain .env files and private keys.
 *
 * Resolution goes through realpath, not string normalization: a `..` check
 * alone is bypassable with a symlink planted inside an allowed root.
 */

/** Set by index.ts once the StateManager exists — room cwds change at runtime. */
let roomCwdProvider: (() => string[]) | null = null;

export function setRoomCwdProvider(fn: () => string[]): void {
  roomCwdProvider = fn;
}

function extraRoots(): string[] {
  return (process.env.OVERLORD_EXTRA_ROOTS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Resolve symlinks as far as the path exists; keep the non-existent tail verbatim.
 *  Needed for writes to files that don't exist yet. */
function realpathDeepest(target: string): string {
  let current = resolve(target);
  const tail: string[] = [];
  // Bounded: every iteration removes one segment, and dirname() is a fixed point at the root.
  for (;;) {
    try {
      return [fs.realpathSync(current), ...tail].join(sep);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function allowedRoots(): string[] {
  const roots = [
    resolve(os.homedir(), '.claude'),
    os.tmpdir(),
    ...(roomCwdProvider?.() ?? []),
    ...extraRoots(),
  ];
  const out: string[] = [];
  for (const r of roots) {
    if (!r) continue;
    try { out.push(fs.realpathSync(r)); } catch { out.push(resolve(r)); }
  }
  return out;
}

function isUnder(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Basenames that are secrets wherever they live. */
const SECRET_BASENAMES = [
  /^\.env($|\.)/i,
  /^id_(rsa|dsa|ecdsa|ed25519)($|\.)/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^credentials$/i,
];

const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk']);

/** Directories never worth exposing, even by name. */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker']);

export function looksSecret(target: string): boolean {
  const base = basename(target);
  if (SECRET_BASENAMES.some(re => re.test(base))) return true;
  if (SECRET_EXTS.has(extname(target).toLowerCase())) return true;
  return target.split(sep).some(seg => SECRET_DIRS.has(seg));
}

export type GuardResult =
  | { ok: true; path: string }
  | { ok: false; status: number; reason: string };

/**
 * Scope a request-supplied path to the allowed roots.
 * `mode: 'browse'` additionally permits anything under $HOME — the spawn
 * dialog's folder picker has to reach projects that are not rooms yet.
 */
export function resolveAllowedPath(
  raw: unknown,
  opts: { mode?: 'file' | 'browse' } = {},
): GuardResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, reason: 'path required' };
  }
  const target = realpathDeepest(raw);
  if (looksSecret(target)) {
    return { ok: false, status: 403, reason: 'path looks like a secret' };
  }
  const roots = allowedRoots();
  if (opts.mode === 'browse') {
    try { roots.push(fs.realpathSync(os.homedir())); } catch { roots.push(resolve(os.homedir())); }
  }
  if (!roots.some(root => isUnder(target, root))) {
    return {
      ok: false,
      status: 403,
      reason: 'path outside allowed roots (set OVERLORD_EXTRA_ROOTS to widen)',
    };
  }
  return { ok: true, path: target };
}
