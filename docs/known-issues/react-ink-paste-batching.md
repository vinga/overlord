# React Ink Treats `text + \r` as Paste, Drops the Submit

**Area:** Message injection — PTY and bridge sessions
**Status:** Fixed

## Symptoms

- Click a burger-menu quick prompt (e.g. "Briefly summarize..."). Text appears in the Claude TUI input box but is never submitted.
- Affects **both** PTY sessions and bridge sessions (Morion / Overlord embedded).
- Manually pressing Enter in the terminal submits the pending text.
- More frequent with longer prompts and pasted content; shorter text sometimes slips through.
- Unrelated to `@file` autocomplete — plain text with no `@` still hits it.

## Root Cause

Claude Code is built on [React Ink](https://github.com/vadimdemedes/ink), which wraps React around raw terminal stdin. Ink's input reader batches bytes that arrive in a single read as a **paste event**. When the inject path wrote `text + '\r'` in one atomic write, Ink treated the whole buffer — including the trailing `\r` — as pasted content and discarded the submit.

The `\r` must arrive as a **distinct** read for Ink to classify it as a keypress.

The `@file` 3-step fix in [at-file-autocomplete-enter-race.md](at-file-autocomplete-enter-race.md) accidentally avoided this bug (it already split writes), which is why the regression only showed up for plain-text burger-menu prompts.

## Fix

Always split `text` and `\r` into **two separate writes** with a length-proportional delay between them:

```
delay = min(600, max(150, text.length)) ms
```

- 150 ms floor — shorter than Ink's paste-coalesce window is unreliable.
- +1 ms per char — long pastes need more time for the TUI to finish rendering before the submit.
- 600 ms ceiling — past this the UX feels laggy.

Applied in both inject paths:

### PTY path — `packages/server/src/api/wsHandler.ts`

The `terminal:inject` handler writes `text` first, schedules `\r` after `firstEnterDelay`, falls back to `macInjector` if either write fails.

### Bridge path — `packages/server/src/pty/injectScheduler.ts`

`scheduleBridgeInject()` applies the same split to the bridge pipe. Special-cases a bare `\r` control sequence (preserves legacy single-shot behavior for callers that pass raw Enter).

### `@file` path unchanged

When `extraEnter=true` (text contains `@`), the 3-step sequence from the autocomplete fix still runs: `text → [400ms] → \r (select) → [300ms] → \r (submit)`.

## Things That Did Not Work

- **80 ms fixed delay** — helped short text, still flaky on long pastes.
- **XTerm bracketed paste** (`\x1b[200~…\x1b[201~`) — Claude Code does **not** enable bracketed paste mode, so the escape sequences leaked into the input as literal characters and no submit fired at all.

## Where to Look If It Regresses

- `packages/server/src/pty/injectScheduler.ts` — `scheduleBridgeInject()`. Verify the two-step split is still there and the delay formula is intact.
- `packages/server/src/api/wsHandler.ts` — `terminal:inject` PTY branch. Verify text is written before `\r`, not together.
- Server logs: `[inject] pty write bytes=N ends="…"` should appear **twice** per send (once for text, once for `\r`).
- If a regression hits only bridge sessions, confirm `!isBridge` guard still routes bridge traffic through `scheduleBridgeInject`, not the PTY branch.
- Tests: `packages/server/src/__tests__/scheduleBridgeInject.test.ts`.
