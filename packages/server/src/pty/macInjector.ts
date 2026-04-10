import { execSync, execFileSync } from 'child_process';

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

  // 2. Escape text for AppleScript string literal (backslash then double-quote)
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  // 3. Build the AppleScript.
  //    `do script` always appends one Enter (newline) — that's the injection Enter.
  //    When extraEnter=true we send an additional empty `do script` to press Enter again.
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
    // Terminal.app not running or accessibility denied
    throw new Error(`macOS Terminal injection failed: ${msg}`);
  }

  return result === 'ok';
}
