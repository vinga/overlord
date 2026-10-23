import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// OVERLORD_AUTO_TRUST_FOLDERS (default OFF; `1`/`true` to enable): pre-accept
// claude's "Do you trust the files in this folder?" dialog for a spawn cwd by
// setting projects[cwd].hasTrustDialogAccepted in ~/.claude.json. Without it a
// spawn into a brand-new folder sits on the dialog with no transcript, so
// Overlord never sees the session.
export function isAutoTrustEnabled(): boolean {
  const v = process.env.OVERLORD_AUTO_TRUST_FOLDERS;
  return v === '1' || v === 'true';
}

/**
 * Mark `cwd` as trusted in ~/.claude.json. No write when already trusted.
 * Best-effort: running claude processes rewrite this file too, so a racing
 * write can drop the key — the dialog then simply shows as before.
 */
export function ensureFolderTrusted(cwd: string, configPath = path.join(os.homedir(), '.claude.json')): boolean {
  const key = path.resolve(cwd);
  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Missing or mid-write — never clobber a file we couldn't parse.
    return false;
  }
  if (config.projects?.[key]?.hasTrustDialogAccepted === true) return false;
  config.projects ??= {};
  config.projects[key] = { ...config.projects[key], hasTrustDialogAccepted: true };
  const tmp = `${configPath}.overlord-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: fs.statSync(configPath).mode });
  fs.renameSync(tmp, configPath);
  return true;
}
