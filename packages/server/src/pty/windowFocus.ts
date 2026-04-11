import { spawn } from 'child_process';

/**
 * Bring a Terminal.app tab to front by matching its TTY device path.
 * macOS only — no-op on other platforms or when tty is empty.
 *
 * Uses `activate` to raise Terminal.app to the OS foreground, then selects
 * the correct tab by TTY so the right session is visible.
 */
export function focusBridgeWindow(tty: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  if (!tty) return Promise.resolve();
  const safeTty = tty.replace(/"/g, '');
  const script = [
    'tell application "Terminal"',
    `  activate`,
    `  repeat with w in windows`,
    `    repeat with t in tabs of w`,
    `      if tty of t is "${safeTty}" then`,
    `        set selected of t to true`,
    `        set index of w to 1`,
    `        return`,
    `      end if`,
    `    end repeat`,
    `  end repeat`,
    `end tell`,
  ].join('\n');
  return new Promise<void>((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
