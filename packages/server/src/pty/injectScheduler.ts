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

/**
 * Injects text into a bridge session via a pipe-write function, with deferred
 * '\r' presses for @file autocomplete (extraEnter=true).
 *
 * Unlike scheduleInject (PTY path), bridge writes are async. If the primary
 * pipe write fails, the fallback is called with the full text so the caller
 * can route via an alternative mechanism (e.g. CGEvent / mac-inject).
 *
 * extraEnter=false: sends `text + '\r'` in a single pipe write (or `text` as-is
 *                   if it already ends with '\r' — prevents double-Enter when
 *                   the caller passes a bare control character like '\r').
 * extraEnter=true:  sends text only, waits autoSelectMs for autocomplete to
 *                   render, sends '\r' to select, waits submitMs, sends '\r'
 *                   to submit. If any deferred '\r' pipe write fails, the
 *                   fallback is called so Enter is not silently lost.
 *
 * @param pipeSend      Async function that writes a string to the bridge pipe.
 *                      Returns true if data was delivered, false otherwise.
 * @param fallback      Called when the initial pipe write fails — receives the
 *                      original text and extraEnter flag so the caller can
 *                      retry via an alternative path.
 * @param enterFallback Called when a deferred '\r' pipe write fails — receives
 *                      just '\r' so the caller can deliver only the Enter.
 * @param text          Text to inject. For plain text, omit the trailing '\r'
 *                      and let the function append it. To send a raw control
 *                      sequence that already ends with '\r' (e.g. bare '\r'),
 *                      pass it as-is — the function will not double-append.
 * @param autoSelectMs  Delay before first '\r' (select autocomplete). Default 400.
 * @param submitMs      Delay before second '\r' (submit). Default 300.
 */
export async function scheduleBridgeInject(
  pipeSend: (data: string) => Promise<boolean>,
  fallback: (text: string, extraEnter: boolean) => Promise<void>,
  enterFallback: () => Promise<void>,
  text: string,
  extraEnter: boolean,
  autoSelectMs = 400,
  submitMs = 300,
): Promise<void> {
  const ok = await pipeSend(extraEnter ? text : (text.endsWith('\r') ? text : text + '\r'));
  if (!ok) {
    await fallback(text, extraEnter);
    return;
  }
  if (!extraEnter) return;

  await delay(autoSelectMs);
  const ok2 = await pipeSend('\r');
  if (!ok2) {
    await enterFallback();
    return;
  }

  await delay(submitMs);
  const ok3 = await pipeSend('\r');
  if (!ok3) {
    await enterFallback();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
