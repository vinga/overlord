import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SHADOW_ROOT = path.join(os.homedir(), '.claude', 'overlord', 'transcripts');

export function shadowPathFor(ovrId: string, sessionId: string): string {
  return path.join(SHADOW_ROOT, ovrId, `${sessionId}.jsonl`);
}

export const SHADOW_ROOT_DIR = SHADOW_ROOT;

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[\\:/.]/g, '-');
}

function canonicalPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Ensure `~/.claude/projects/<slug>/<sid>.jsonl` exists by hard-linking from the
 * shadow store. `claude --resume <sid>` reads the canonical path; if /clear (or
 * any external tool) deleted it, the TUI starts but cannot load the conversation
 * and the input loop dies. Returns the canonical path on success, null otherwise.
 */
export function restoreCanonicalFromShadow(ovrId: string, sessionId: string, cwd: string): string | null {
  if (!ovrId || !sessionId || !cwd) return null;
  const canonical = canonicalPathFor(cwd, sessionId);
  try {
    if (fs.existsSync(canonical)) return canonical;
  } catch { return null; }
  const shadow = shadowPathFor(ovrId, sessionId);
  try {
    if (!fs.existsSync(shadow)) return null;
  } catch { return null; }
  try { fs.mkdirSync(path.dirname(canonical), { recursive: true }); } catch { /* ignore */ }
  try {
    fs.linkSync(shadow, canonical);
    return canonical;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return canonical;
    if (err?.code === 'EXDEV') {
      try {
        fs.copyFileSync(shadow, canonical);
        return canonical;
      } catch { return null; }
    }
    return null;
  }
}

let warnedExdev = false;

/**
 * Hard-link a Claude transcript into our shadow store so it survives external
 * deletion (notably Claude's /clear cleanup). Idempotent.
 */
export function ensureShadow(ovrId: string, sessionId: string, originalPath: string | null | undefined): void {
  if (!ovrId || !sessionId || !originalPath) return;
  const shadow = shadowPathFor(ovrId, sessionId);
  try {
    if (fs.existsSync(shadow)) return;
  } catch { return; }
  try { fs.mkdirSync(path.dirname(shadow), { recursive: true }); } catch { /* ignore */ }
  try {
    fs.linkSync(originalPath, shadow);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EEXIST') return;
    if (err?.code === 'EXDEV') {
      try {
        fs.copyFileSync(originalPath, shadow);
        if (!warnedExdev) {
          console.warn('[shadow] EXDEV — falling back to copy. Shadow will not auto-update.');
          warnedExdev = true;
        }
      } catch { /* ignore */ }
    }
  }
}

export function shadowExists(ovrId: string, sessionId: string): boolean {
  try { return fs.existsSync(shadowPathFor(ovrId, sessionId)); } catch { return false; }
}

export function removeShadowDir(ovrId: string): void {
  if (!ovrId) return;
  const dir = path.join(SHADOW_ROOT, ovrId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
