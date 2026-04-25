import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SHADOW_ROOT = path.join(os.homedir(), '.claude', 'overlord', 'transcripts');

export function shadowPathFor(ovrId: string, sessionId: string): string {
  return path.join(SHADOW_ROOT, ovrId, `${sessionId}.jsonl`);
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
