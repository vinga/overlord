import * as os from 'os';

// Only active on Windows
const IS_WINDOWS = process.platform === 'win32';

// A real Claude permission dialog always has "do you want to ..."
// AND at least one of the secondary signals. Requiring co-occurrence eliminates
// false positives from slow tool runs, other TUI menus, or Claude's generated text.
const PRIMARY_PATTERN   = /do you want to/i;
const SECONDARY_PATTERNS = [
  /esc to cancel/i,
  /yes,? (?:and )?allow .* (?:during|for) this session/i,
  /don'?t ask again/i,          // newer permission format: "Yes, and don't ask again for X"
  /\(esc\)/i,                    // newer format puts "(esc)" at end of option 3
  /^\s*\d\.\s+yes\b/im,         // numbered option list starting with "1. Yes"
];

function looksLikePermissionPrompt(text: string): boolean {
  return PRIMARY_PATTERN.test(text) &&
         SECONDARY_PATTERNS.some(p => p.test(text));
}

function extractPromptBlock(text: string): string {
  const lines = text.split('\n');
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty > 0 && lines[lastNonEmpty].trim() === '') lastNonEmpty--;
  const start = Math.max(0, lastNonEmpty - 14);
  return lines.slice(start, lastNonEmpty + 1).join('\n');
}

function cleanText(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[^\x20-\x7E]/g, '').trimEnd())
    .filter((line, i, arr) => {
      // Remove runs of empty lines (keep at most one blank between content)
      if (line === '' && i > 0 && arr[i - 1] === '') return false;
      return true;
    })
    .join('\n')
    .trim();
}

// Rate-limit prompt: Claude CLI blocks on Enter when the usage limit is hit
const RATE_LIMIT_PATTERN = /you'?ve hit your limit/i;

// Detect permission mode from the CLI status bar text
const PERMISSION_MODE_PATTERNS: Array<{ pattern: RegExp; mode: string }> = [
  { pattern: />>\s+bypass permissions on/i, mode: 'bypassPermissions' },
  { pattern: />>\s+accept edits on/i, mode: 'acceptEdits' },
  { pattern: />>\s+plan mode on/i, mode: 'plan' },
];

function detectPermissionMode(text: string): string | undefined {
  // Scan lines from the bottom — the status bar is always at the end of the
  // terminal repaint, so the last matching line reflects the current mode.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const { pattern, mode } of PERMISSION_MODE_PATTERNS) {
      if (pattern.test(line)) return mode;
    }
  }
  return undefined;
}

export interface PermissionCheckable {
  getAllSessionIds(): string[];
  getSession(id: string): { pid: number; state: string; permissionMode?: string; permissionModeLockedUntil?: number } | undefined;
  setNeedsPermission(sessionId: string, value: boolean, promptText?: string, isLimitPrompt?: boolean): void;
  setPermissionMode(sessionId: string, mode: string | undefined): void;
}

export function startPermissionChecker(
  stateManager: PermissionCheckable,
  getScreenText?: (sessionId: string, pid: number) => Promise<string | null>,
  injectIntoSession?: (sessionId: string, text: string) => Promise<void>,
): (() => void) | undefined {
  // On non-Windows, only proceed if a cross-platform screen reader is provided
  if (!IS_WINDOWS && !getScreenText) return undefined;

  // Lazy import to avoid loading on non-Windows
  let readScreen: ((pid: number) => Promise<string | null>) | undefined;

  if (IS_WINDOWS) {
    const load = async () => {
      const mod = await import('../pty/consoleInjector.js');
      readScreen = mod.readScreen;
    };
    load().catch(() => { /* ignore — runCycle will retry */ });
  }

  // Hysteresis: only clear needsPermission after 3 consecutive misses
  const missCount = new Map<string, number>();

  let stopped = false;

  const runCycle = async () => {
    if (stopped) return;
    if (!readScreen && !getScreenText) {
      // Windows console reader not loaded yet and no custom screen reader — retry soon
      setTimeout(runCycle, 1000);
      return;
    }
    const ids = stateManager.getAllSessionIds();

    // Remove stale entries from missCount for sessions no longer tracked
    for (const id of missCount.keys()) {
      if (!ids.includes(id)) missCount.delete(id);
    }

    for (const id of ids) {
      if (stopped) break;
      const session = stateManager.getSession(id);
      if (!session) continue;
      // Only check sessions that might be stuck
      if (session.state === 'closed') continue;
      try {
        const text = getScreenText
          ? await getScreenText(id, session.pid)
          : (readScreen ? await readScreen(session.pid) : null);
        const hasPrompt = text ? looksLikePermissionPrompt(text) : false;
        if (hasPrompt) {
          // Prompt detected: set flag and reset miss counter
          missCount.set(id, 0);
          stateManager.setNeedsPermission(id, true, cleanText(extractPromptBlock(text!)));
        } else {
          // No prompt detected from screen: do NOT clear — the transcript heuristic
          // owns clearing. Screen reader only CONFIRMS/ENHANCES, never removes.
          missCount.set(id, (missCount.get(id) ?? 0) + 1);
        }
        // Rate-limit prompt: surface it in the UI so the user can dismiss manually
        if (text && RATE_LIMIT_PATTERN.test(text)) {
          if (!hasPrompt) {
            // Not already flagged as a normal permission prompt — flag as limit prompt
            stateManager.setNeedsPermission(id, true, cleanText(extractPromptBlock(text)), true);
          }
        }
        // Detect permission mode from status bar
        if (text) {
          const screenMode = detectPermissionMode(text);
          const currentSession = stateManager.getSession(id);
          const current = currentSession?.permissionMode;
          const locked = currentSession?.permissionModeLockedUntil !== undefined && Date.now() < currentSession.permissionModeLockedUntil;
          if (screenMode) {
            // Always call setPermissionMode when screen confirms a non-default mode —
            // even if unchanged — so the lock is refreshed every 3s cycle and the
            // transcript can never overwrite it while the mode is visible in terminal.
            stateManager.setPermissionMode(id, screenMode);
          } else if (!screenMode && current && current !== 'default' && !locked) {
            // Status bar doesn't show a mode and lock has expired → back to default
            stateManager.setPermissionMode(id, 'default');
          }
        }
      } catch (err) {
        console.log(`[permCheck] ${id.slice(0,8)} error: ${err}`);
      }
    }

    // Schedule next cycle after completion (no overlap)
    if (!stopped) setTimeout(runCycle, 3000);
  };

  // Start first cycle after initial delay
  const timer = setTimeout(runCycle, 3000);

  return () => { stopped = true; clearTimeout(timer); };
}
