/**
 * Determines whether a message needs the extraEnter three-step sequence.
 * Messages containing '@' have a file reference that requires Claude Code's
 * autocomplete to resolve, so we send text first, wait for autocomplete to
 * render, then send two '\r' presses (select + submit).
 */
export function shouldUseExtraEnter(text: string): boolean {
  return text.includes('@');
}

/**
 * Delay before the first deferred '\r' after the text write.
 *
 * React Ink batches bytes that arrive in one read as a paste event, so
 * `text + '\r'` written atomically loses the submit. We always split the
 * write and delay '\r' so Ink classifies it as a distinct keypress.
 *
 * Plain text: 150 ms floor, +1 ms per char, 600 ms cap — longer pastes
 * need more time for the TUI to finish rendering before submit arrives.
 * extraEnter (@file autocomplete): fixed `autoSelectMs` (default 400 ms)
 * so the autocomplete dropdown has time to render before selection.
 */
export function computeFirstEnterDelay(text: string, extraEnter: boolean, autoSelectMs = 400): number {
  return extraEnter ? autoSelectMs : Math.min(600, Math.max(150, text.length));
}

/**
 * Injects text into a synchronous-write target (PTY stdin) using the two-step
 * text/\r split that React Ink requires, with a three-step sequence for
 * @file autocomplete messages.
 *
 * extraEnter=false (plain text):
 *   text → [computeFirstEnterDelay] → \r (submit)
 *
 * extraEnter=true (@file autocomplete):
 *   text → [autoSelectMs] → \r (select) → [submitMs] → \r (submit)
 *
 * @param write        Sync write function. Returns true on success, false on failure.
 * @param isAlive      Guard called before each deferred write — skip if target died.
 * @param onWriteFail  Called when a write returns false. `initial` is true if the
 *                     failure was the initial text write (caller may fall back with
 *                     the full text + extraEnter); false if it was a deferred '\r'
 *                     (caller should just deliver Enter).
 * @param text         Text to inject (without trailing '\r').
 * @param extraEnter   Whether to use the three-step autocomplete sequence.
 * @param autoSelectMs Delay before first '\r' when extraEnter=true. Default 400.
 * @param submitMs     Delay before second '\r' when extraEnter=true. Default 300.
 */
export function scheduleInject(
  write: (data: string) => boolean,
  isAlive: () => boolean,
  onWriteFail: (data: string, initial: boolean) => void,
  text: string,
  extraEnter: boolean,
  autoSelectMs = 400,
  submitMs = 300,
): void {
  if (!write(text)) {
    onWriteFail(text, true);
    return;
  }
  const firstDelay = computeFirstEnterDelay(text, extraEnter, autoSelectMs);
  setTimeout(() => {
    if (!isAlive()) return;
    if (!write('\r')) {
      onWriteFail('\r', false);
      return;
    }
    if (!extraEnter) return;
    setTimeout(() => {
      if (!isAlive()) return;
      if (!write('\r')) onWriteFail('\r', false);
    }, submitMs);
  }, firstDelay);
}

/**
 * Injects text into a bridge session via an async pipe-write function, using
 * the same text/\r split as scheduleInject but awaiting each write.
 *
 * Unlike scheduleInject (sync PTY path), bridge writes are async. If the
 * initial pipe write fails, the fallback is called with the full text so the
 * caller can route via an alternative mechanism (e.g. CGEvent / mac-inject).
 *
 * extraEnter=false (plain text):
 *   text → [computeFirstEnterDelay] → \r (submit)
 *   Special case: if the caller passes a raw control sequence that already
 *   ends with '\r' (e.g. a bare Enter keystroke), it is sent in a single
 *   pipe write to preserve legacy single-shot behavior.
 *
 * extraEnter=true (@file autocomplete):
 *   text → [autoSelectMs] → \r (select) → [submitMs] → \r (submit)
 *
 * @param pipeSend      Async function that writes a string to the bridge pipe.
 *                      Returns true if data was delivered, false otherwise.
 * @param fallback      Called when the initial pipe write fails — receives the
 *                      original text and extraEnter flag so the caller can
 *                      retry via an alternative path.
 * @param enterFallback Called when a deferred '\r' pipe write fails — caller
 *                      can deliver just the Enter.
 * @param text          Text to inject. For plain text, omit the trailing '\r'
 *                      and let the function append it. To send a raw control
 *                      sequence that already ends with '\r' (e.g. bare '\r'),
 *                      pass it as-is — the function will not double-append.
 * @param extraEnter    Whether to use the three-step autocomplete sequence.
 * @param autoSelectMs  Delay before first '\r' when extraEnter=true. Default 400.
 * @param submitMs      Delay before second '\r' when extraEnter=true. Default 300.
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
  // Special case: caller passed a raw control sequence that already ends with \r
  // (e.g. a bare Enter keystroke). Preserve legacy single-shot behavior.
  if (!extraEnter && text.endsWith('\r')) {
    const ok = await pipeSend(text);
    if (!ok) await fallback(text, extraEnter);
    return;
  }

  const ok = await pipeSend(text);
  if (!ok) {
    await fallback(text, extraEnter);
    return;
  }

  await delay(computeFirstEnterDelay(text, extraEnter, autoSelectMs));
  const ok2 = await pipeSend('\r');
  if (!ok2) {
    await enterFallback();
    return;
  }

  if (!extraEnter) return;
  await delay(submitMs);
  const ok3 = await pipeSend('\r');
  if (!ok3) {
    await enterFallback();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
