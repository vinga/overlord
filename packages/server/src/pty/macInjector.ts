import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the compiled mac-inject binary (sits in packages/server/)
// __dirname = packages/server/src/pty  → ../../ = packages/server/
const MAC_INJECT_BIN = join(__dirname, '..', '..', 'mac-inject');
const MAC_INJECT_SRC = join(__dirname, '..', '..', 'mac-inject.c');

// ── CGEvent-based injection (works for any app: IntelliJ, iTerm2, etc.) ──────

/**
 * Ensure the mac-inject binary is compiled and present.
 * Compiles from source automatically on first use.
 */
function ensureMacInjectBinary(): boolean {
  if (existsSync(MAC_INJECT_BIN)) return true;
  if (!existsSync(MAC_INJECT_SRC)) return false;
  try {
    execSync(
      `cc -framework ApplicationServices -o "${MAC_INJECT_BIN}" "${MAC_INJECT_SRC}"`,
      { timeout: 15_000, stdio: 'pipe' },
    );
    return existsSync(MAC_INJECT_BIN);
  } catch {
    return false;
  }
}

/**
 * Inject text into any macOS process via CGEventPostToPid (keyboard events).
 *
 * Does NOT steal OS-level focus, but events go to whatever is focused WITHIN
 * the target process. For IntelliJ: the terminal pane must be the active panel.
 *
 * Requires Accessibility permission for the calling app (Terminal, etc.).
 * Returns 'ok' | 'accessibility:denied' | 'error' | 'no-binary'.
 */
export function injectViaCGEvent(pid: number, text: string, extraEnter = false): 'ok' | 'accessibility:denied' | 'error' | 'no-binary' {
  if (process.platform !== 'darwin') return 'error';
  if (!ensureMacInjectBinary()) return 'no-binary';

  // Append newline — mac-inject treats \n as Enter
  const payload = extraEnter ? text + '\n\n' : text + '\n';

  const result = spawnSync(MAC_INJECT_BIN, [String(pid), payload], {
    encoding: 'utf8',
    timeout: 5000,
  });

  if (result.stderr?.includes('accessibility:denied')) return 'accessibility:denied';
  if (result.status === 0) return 'ok';
  return 'error';
}

// ── Terminal.app AppleScript injection ────────────────────────────────────────

/**
 * Inject text into a native Claude session running in Terminal.app on macOS.
 *
 * Uses AppleScript `do script` to route text to the Terminal tab whose TTY
 * matches the target process, without stealing window focus.
 *
 * Returns true if injection succeeded, false if the tab was not found or
 * Terminal.app is not running. Throws on unexpected errors.
 */
export async function injectViaMacTerminal(
  pid: number,
  text: string,
  extraEnter = false,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  // 1. Resolve the TTY for this PID
  let ttyShort: string;
  try {
    ttyShort = execFileSync('ps', ['-p', String(pid), '-o', 'tty='], { encoding: 'utf8' }).trim();
  } catch {
    return false;
  }
  if (!ttyShort || ttyShort === '??') return false;

  const ttyPath = ttyShort.startsWith('/dev/') ? ttyShort : `/dev/${ttyShort}`;

  // 2. Escape text for AppleScript string literal
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  // 3. Build the AppleScript.
  //    `do script` always appends one Enter. extraEnter sends a second empty script.
  const script = [
    'tell application "Terminal"',
    `  set targetTTY to "${ttyPath}"`,
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      if tty of t is targetTTY then',
    `        do script "${escaped}" in t`,
    extraEnter ? '        do script "" in t' : '',
    '        return "ok"',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  return "not found"',
    'end tell',
  ].filter(Boolean).join('\n');

  let result: string;
  try {
    result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`macOS Terminal injection failed: ${msg}`);
  }

  return result === 'ok';
}

// ── Unified inject: Terminal.app first, CGEvent fallback ──────────────────────

/**
 * Best-effort injection for macOS native sessions.
 * 1. Tries Terminal.app AppleScript (no permissions needed, reliable).
 * 2. Falls back to CGEventPostToPid for other terminals (IntelliJ, iTerm2, etc.).
 *
 * Returns true on success, throws with a descriptive message on failure.
 */
export async function injectViaMac(pid: number, text: string, extraEnter = false): Promise<boolean> {
  // Try Terminal.app first
  const terminalOk = await injectViaMacTerminal(pid, text, extraEnter);
  if (terminalOk) return true;

  // Fall back to CGEvent (works for IntelliJ etc., needs Accessibility).
  // IMPORTANT: send to the GUI app's PID, not the CLI child — CLI processes have
  // no event loop so CGEventPostToPid is silently dropped.
  const { name: app, guiPid } = detectTerminalInfo(pid);
  const cgResult = injectViaCGEvent(guiPid, text, extraEnter);

  if (cgResult === 'ok') return true;

  if (cgResult === 'accessibility:denied') {
    throw new Error(
      `Injection into ${app} requires Accessibility permission. ` +
      `Go to System Settings → Privacy & Security → Accessibility and add Terminal.app.`
    );
  }

  if (cgResult === 'no-binary') {
    throw new Error(
      `Injection into ${app} requires the mac-inject binary. ` +
      `Run: cc -framework ApplicationServices -o packages/server/mac-inject packages/server/mac-inject.c`
    );
  }

  throw new Error(`CGEvent injection into ${app} (PID ${guiPid}) failed.`);
}

// ── Terminal app detection ────────────────────────────────────────────────────

interface TerminalInfo {
  name: string;
  /** PID of the GUI app that owns the PTY master (send CGEvents here, not to the CLI child) */
  guiPid: number;
}

/**
 * Walk the process tree upward to find the owning GUI terminal application.
 * Returns the app name and the PID of the GUI process that holds the PTY master.
 * CGEvents must be sent to the GUI process — CLI child processes have no event loop.
 */
export function detectTerminalApp(pid: number): string {
  return detectTerminalInfo(pid).name;
}

export function detectTerminalInfo(pid: number): TerminalInfo {
  let cur = pid;
  for (let i = 0; i < 10; i++) {
    try {
      const ppid = execFileSync('ps', ['-p', String(cur), '-o', 'ppid='], { encoding: 'utf8' }).trim();
      const comm = execFileSync('ps', ['-p', String(ppid), '-o', 'comm='], { encoding: 'utf8' }).trim();
      const ppidNum = parseInt(ppid, 10);
      if (comm.includes('idea')) return { name: 'IntelliJ IDEA', guiPid: ppidNum };
      if (comm.includes('Terminal')) return { name: 'Terminal', guiPid: ppidNum };
      if (comm.includes('iTerm')) return { name: 'iTerm2', guiPid: ppidNum };
      if (comm.includes('WezTerm')) return { name: 'WezTerm', guiPid: ppidNum };
      if (comm.includes('Alacritty')) return { name: 'Alacritty', guiPid: ppidNum };
      if (comm.includes('kitty')) return { name: 'kitty', guiPid: ppidNum };
      if (ppid === '1' || ppid === cur.toString()) break;
      cur = ppidNum;
    } catch {
      break;
    }
  }
  return { name: 'unknown', guiPid: pid };
}
