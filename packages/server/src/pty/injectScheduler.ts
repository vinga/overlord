/**
 * Determines whether a message needs the extraEnter two-step sequence.
 * Messages containing '@' have a file reference that requires Claude Code's
 * autocomplete to resolve, so we send text first, wait for autocomplete to
 * render, then send two '\r' presses (select + submit).
 */
export function shouldUseExtraEnter(text: string): boolean {
  return text.includes('@');
}

/**
 * Writes text to a PTY with optional two-step Enter sequence for @file refs.
 *
 * extraEnter=false: writes `text + '\r'` atomically.
 * extraEnter=true:  writes text only, waits 400 ms for autocomplete to render,
 *                   sends '\r' to select, waits 300 ms, sends '\r' to submit.
 *
 * @param write     Function to send data to the PTY.
 * @param isAlive   Guard called before each deferred write — skip if PTY died.
 * @param text      Text to inject (without trailing '\r').
 * @param extraEnter Whether to use the two-step Enter sequence.
 */
export function scheduleInject(
  write: (data: string) => void,
  isAlive: () => boolean,
  text: string,
  extraEnter: boolean,
): void {
  if (!extraEnter) {
    write(text + '\r');
    return;
  }
  write(text);
  setTimeout(() => {
    if (!isAlive()) return;
    write('\r');
    setTimeout(() => {
      if (!isAlive()) return;
      write('\r');
    }, 300);
  }, 400);
}
