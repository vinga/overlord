import { execSync, execFileSync, spawnSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

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

// ── Terminal.app injection via activate + System Events ──────────────────────

/**
 * Convert a text string (with escape sequences) to AppleScript keystroke commands
 * for System Events. Batches consecutive printable chars into a single keystroke call
 * (avoids per-char timing issues). Maps \r/\n → Return, \x1b[B → Down,
 * \x1b[Z → Shift+Tab, \x1b → Escape, \x03 → Ctrl+C.
 */
function textToAppleScriptKeystrokes(text: string, extraEnter = false): string {
  const lines: string[] = [];
  let batch = '';

  const flushBatch = () => {
    if (!batch) return;
    const escaped = batch.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`keystroke "${escaped}"`);
    batch = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\r' || ch === '\n') {
      flushBatch();
      lines.push('key code 36');           // Return (kVK_Return)
      i++;
    } else if (ch === '\x1b') {
      flushBatch();
      if (text[i + 1] === '[' && text[i + 2] === 'B') {
        lines.push('key code 125');        // Down arrow
        i += 3;
      } else if (text[i + 1] === '[' && text[i + 2] === 'Z') {
        lines.push('keystroke tab using shift down');  // Shift+Tab
        i += 3;
      } else {
        lines.push('key code 53');         // Escape
        i++;
      }
    } else if (code === 0x03) {
      flushBatch();
      lines.push('keystroke "c" using control down');  // Ctrl+C
      i++;
    } else {
      batch += ch;                         // accumulate printable chars
      i++;
    }
  }
  flushBatch();
  if (extraEnter) lines.push('key code 36');
  return lines.map(l => `    ${l}`).join('\n');
}

/**
 * Returns true if the text contains only printable ASCII, \r, and \n
 * (i.e. can be injected via `do script` + stty inlcr without escape sequences).
 */
function isDoScriptCompatible(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d || c === 0x0a) continue; // CR / LF
    if (c >= 0x20 && c <= 0x7e) continue;   // printable ASCII
    return false; // control char or escape sequence
  }
  return true;
}

/**
 * Inject into a Terminal.app tab using `stty inlcr` + `do script`.
 *
 * The core trick: set the `inlcr` terminal flag so that LF (0x0A) arriving at
 * the process is converted to CR (0x0D). `do script "text"` always appends an
 * implicit LF; with `inlcr` on that LF becomes the CR that Claude Code's Ink
 * TUI expects for Enter. No focus stealing — `do script` routes by TTY.
 *
 * Only works for text that contains no escape sequences (use the System Events
 * fallback for \x1b, \x03, etc.).
 *
 * Returns true if the tab was found and injection succeeded.
 */
async function injectViaDoScriptWithCR(
  pid: number,
  text: string,
  extraEnter = false,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  let ttyShort: string;
  try {
    ttyShort = execFileSync('ps', ['-p', String(pid), '-o', 'tty='], { encoding: 'utf8' }).trim();
  } catch {
    return false;
  }
  if (!ttyShort || ttyShort === '??') return false;

  const ttyPath = ttyShort.startsWith('/dev/') ? ttyShort : `/dev/${ttyShort}`;

  // Strip trailing CR/LF from text — `do script` appends its own Enter (LF).
  // With inlcr on, that LF becomes CR (the submit key Claude Code expects).
  const stripped = text.replace(/[\r\n]+$/, '');

  // Escape text for AppleScript string literal
  const escaped = stripped
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  const script = `
tell application "Terminal"
  set targetTTY to "${ttyPath}"
  set found to false
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        do script "${escaped}" in t
        ${extraEnter ? 'do script "" in t' : ''}
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
  if not found then return "not found"
  return "ok"
end tell
`;

  // Set inlcr so the implicit LF appended by `do script` is delivered to the process as CR.
  // We do NOT clear it afterwards — the race condition (Terminal.app writes bytes after
  // osascript returns) makes any cleanup racy. It is safe to leave set permanently:
  //   • Terminal.app sends CR (not LF) when the user presses Return — inlcr doesn't affect it.
  //   • inlcr is an INPUT flag — Claude's output is completely unaffected.
  //   • The flag is reset when the PTY is closed/deallocated.
  try { execSync(`stty inlcr < "${ttyPath}"`, { encoding: 'utf8', timeout: 2000, shell: true }); } catch { /* ignore */ }

  try {
    const result = execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    console.log(`[inject:doScript] pid=${pid} tty=${ttyPath} result="${result}"`);
    return result === 'ok';
  } catch (e) {
    console.log(`[inject:doScript] pid=${pid} tty=${ttyPath} ERROR: ${String(e)}`);
    return false;
  }
}

/**
 * Inject text into a Terminal.app tab via CGEventPostToPid (mac-inject) WITHOUT
 * stealing OS-level focus from the user's current application.
 *
 * Strategy (minimal focus steal, ~5 ms):
 *  1. Single osascript call: find tab by TTY, select it, `activate` Terminal.
 *  2. `do shell script` mac-inject (stdin mode) inside the same script.
 *  3. Restore prevApp — all within one osascript, so focus is stolen only for
 *     the ~5 ms mac-inject binary execution, not the full osascript round-trips.
 *
 * Why mac-inject instead of System Events keystroke:
 *  - `keystroke` resolves chars through the CURRENT KEYBOARD LAYOUT.
 *    Non-US layouts (e.g. Polish Pro) garble ASCII characters.
 *  - mac-inject uses CGEventKeyboardSetUnicodeString — layout-independent, exact.
 */
async function injectViaMacTerminalFocus(
  pid: number,
  text: string,
  extraEnter = false,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (!ensureMacInjectBinary()) return false;

  let ttyShort: string;
  try {
    ttyShort = execFileSync('ps', ['-p', String(pid), '-o', 'tty='], { encoding: 'utf8' }).trim();
  } catch {
    return false;
  }
  if (!ttyShort || ttyShort === '??') return false;

  const ttyPath = ttyShort.startsWith('/dev/') ? ttyShort : `/dev/${ttyShort}`;
  const { guiPid } = detectTerminalInfo(pid);

  // Write inject payload to a temp file — avoids all shell/AppleScript escaping.
  // mac-inject reads from stdin when second arg is "-"; we redirect the temp file.
  const injectPayload = extraEnter ? text + '\n\n' : text + '\n';
  const tmpFile = `/tmp/overlord-inject-${randomBytes(6).toString('hex')}.txt`;
  try {
    writeFileSync(tmpFile, injectPayload, 'utf8');
  } catch { return false; }

  // Single osascript call: find tab → activate → bring window to front (as key window)
  // → mac-inject (stdin) → restore.
  //
  // Key ordering: `activate` FIRST, then `set index of targetWindow to 1`.
  // When the app is already active, `orderFront:` (what `set index` calls) makes
  // the window the KEY window. Doing it before `activate` only changes Z-order —
  // macOS restores whichever window was last key when the app re-activates.
  //
  // Focus is stolen for only ~20 ms: the time between `activate` taking effect
  // and the `tell application prevApp to activate` at the end of the script.
  const script = `
set prevApp to name of (info for (path to frontmost application))
tell application "Terminal"
  set targetTTY to "${ttyPath}"
  set targetWindow to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set selected of t to true
        set targetWindow to w
        exit repeat
      end if
    end repeat
    if targetWindow is not missing value then exit repeat
  end repeat
  if targetWindow is missing value then
    do shell script "rm -f ${tmpFile}"
    return "not found"
  end if
  activate
  -- Set index AFTER activate so orderFront makes it the key window
  set index of targetWindow to 1
end tell
-- Brief delay so Terminal's key-window change propagates before CGEvents are sent.
-- Without this, events may still route to the previously-focused window.
delay 0.02
do shell script "${MAC_INJECT_BIN} ${guiPid} - < ${tmpFile}; rm -f ${tmpFile}"
if prevApp is not "Terminal" then
  tell application prevApp to activate
end if
return "ok"
`;

  try {
    const r = execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
    return r === 'ok';
  } catch {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    return false;
  }
}

// ── Terminal.app AppleScript injection ────────────────────────────────────────

/**
 * Inject text into a native Claude session running in Terminal.app on macOS.
 *
 * Uses AppleScript `do script` to route text to the Terminal tab whose TTY
 * matches the target process, without stealing window focus.
 *
 * NOTE: `do script` always converts CR (0x0D) → LF (0x0A), so this function
 * is only kept as a last-resort fallback for plain text. Use `injectViaMac`
 * which routes through CGEvent for correct \r handling.
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

// ── Unified inject: CGEvent with tab selection ────────────────────────────────

/**
 * Best-effort injection for macOS native sessions.
 *
 * For Terminal.app: selects the correct tab by TTY (via AppleScript, no focus
 * steal), then sends hardware key events via CGEventPostToPid. This correctly
 * delivers CR (0x0D) for Enter — unlike `do script` which converts CR→LF.
 *
 * For other terminals (IntelliJ, iTerm2, etc.): sends CGEvents directly to the
 * GUI app PID (which owns the focused terminal pane).
 *
 * Returns true on success, throws with a descriptive message on failure.
 */
export async function injectViaMac(pid: number, text: string, extraEnter = false): Promise<boolean> {
  const { name: app, guiPid } = detectTerminalInfo(pid);
  console.log(`[inject:mac] pid=${pid} app="${app}" guiPid=${guiPid} extraEnter=${extraEnter}`);

  if (app === 'Terminal') {
    // CGEvent + brief activate (~20ms focus steal): reliable for all Terminal.app sessions.
    // `do script` is not used — it silently fails to deliver bytes for many sessions.
    const ok = await injectViaMacTerminalFocus(pid, text, extraEnter);
    if (ok) return true;
    // Last resort: direct CGEvent to GUI PID (single-window case)
  }

  // For other terminals (IntelliJ, iTerm2, etc.): CGEvent to the GUI app PID.
  // These apps have a single focused terminal pane without the multi-window problem.
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
