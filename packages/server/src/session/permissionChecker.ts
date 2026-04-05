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

export interface PermissionCheckable {
  getAllSessionIds(): string[];
  getSession(id: string): { pid: number; state: string } | undefined;
  setNeedsPermission(sessionId: string, value: boolean, promptText?: string): void;
}

export function startPermissionChecker(stateManager: PermissionCheckable): (() => void) | undefined {
  if (!IS_WINDOWS) return undefined;

  // Lazy import to avoid loading on non-Windows
  let readScreen: ((pid: number) => Promise<string | null>) | undefined;

  const load = async () => {
    const mod = await import('../pty/consoleInjector.js');
    readScreen = mod.readScreen;
  };

  load().catch(() => { /* ignore */ });

  // Hysteresis: only clear needsPermission after 3 consecutive misses
  const missCount = new Map<string, number>();

  let stopped = false;

  const runCycle = async () => {
    if (stopped || !readScreen) return;
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
        const text = await readScreen(session.pid);
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
      } catch {
        // ignore
      }
    }

    // Schedule next cycle after completion (no overlap)
    if (!stopped) setTimeout(runCycle, 3000);
  };

  // Start first cycle after initial delay
  const timer = setTimeout(runCycle, 3000);

  return () => { stopped = true; clearTimeout(timer); };
}
