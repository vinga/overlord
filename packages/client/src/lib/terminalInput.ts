/** Filtering for data xterm.js hands us on `onData` before it goes to the PTY.
 *
 *  xterm routes MORE than keystrokes through `onData` — focus reports and mouse
 *  reports travel the same `triggerDataEvent` path. Whatever the running TUI
 *  enabled, we get, and anything the TUI then fails to consume shows up as
 *  literal garbage in its prompt.
 *
 *  Claude Code enables all of `?1000` (click), `?1002` (drag), `?1003`
 *  (any-event = a report per mouse MOVE) and `?1006` (SGR encoding) — verified
 *  against a captured stream in
 *  `packages/server/src/__tests__/fixtures/claude-pty-stream.json`, which shows
 *  those modes enabled and never disabled. `?1003` in particular means the
 *  terminal emits a report for every pixel of movement across it.
 */

/** SGR mouse report: ESC [ < button ; col ; row (M|m) */
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** Legacy X10 report: ESC [ M followed by three raw bytes. */
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g;
/** Focus in/out, emitted when the TUI enables `?1004`. */
const FOCUS_REPORTS = /\x1b\[I|\x1b\[O/g;

const MOTION_FLAG = 32;

/**
 * Strip terminal reports that are noise rather than user intent.
 *
 * Removed:
 *  - focus in/out (`ESC[I` / `ESC[O`)
 *  - mouse MOTION reports (button bit 32) — the flood: `?1003` means one report
 *    per mouse move, and Claude's TUI has no hover behaviour that uses them
 *  - legacy X10 mouse reports, which carry no button byte we can inspect
 *
 * Kept:
 *  - plain button press/release, so clicking a TUI menu option still works
 *  - WHEEL reports (bit 64). With mouse tracking enabled xterm forwards wheel to
 *    the application instead of scrolling its own buffer, so filtering them
 *    would kill scrolling inside the embedded terminal. Motion is the part that
 *    floods; wheel only fires on deliberate user action, and the TUI consumes it.
 */
export function filterTerminalInput(data: string): string {
  return data
    .replace(FOCUS_REPORTS, '')
    .replace(SGR_MOUSE, (full, button: string) => {
      const b = Number(button);
      // Wheel reports also set bit 32 in some encodings; check wheel first so a
      // scroll is never mistaken for motion and dropped.
      if ((b & 64) !== 0) return full;
      return (b & MOTION_FLAG) !== 0 ? '' : full;
    })
    .replace(X10_MOUSE, '');
}
