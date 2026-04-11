# @file Autocomplete Consumes \r on Inject

**Area:** Message injection — bridge and PTY sessions  
**Status:** Fixed

## Symptoms

- Injecting a message that contains `@/path/to/file` (e.g. a pasted image) appears to send successfully (server logs show `[inject] ok`), but the text sits unsubmitted in the Claude TUI input box.
- Manually pressing Enter in the terminal submits it.
- Affects bridge sessions; less commonly PTY sessions.
- Seems to work when `@file` is the first token in the message, but not when preceded by plain text (e.g. `"here @/tmp/image.jpg"` fails, `"@/tmp/image.jpg"` may succeed).

## Root Cause

When Claude TUI receives text containing `@`, it opens an autocomplete dropdown. This autocomplete intercepts the next `\r` keystroke to **select** the completion, consuming it before the message can be submitted.

The original inject code sent `text + '\r'` atomically. The `\r` arrived in the same write batch as the text, often before the autocomplete overlay had fully rendered. The TUI's event loop queued the `\r` as "select autocomplete", leaving the message with no remaining Enter to submit it.

A second `\r` was added (the `extraEnter` path), but it was sent after 400 ms via the same bridge — by which point the first `\r` had already been consumed for selection, so the second arrived and submitted correctly **only if the autocomplete had rendered fast enough**. Ordering was flaky.

The order-sensitivity (text-first vs `@`-first) likely comes from how the TUI renders partial autocomplete state — when `@file` is the leading token the cursor/state machine may behave differently.

## Fix

Three-step inject sequence when `extraEnter=true`:

1. Send **text only** — no `\r`. Let the TUI render the autocomplete dropdown.
2. After **400 ms** — send `\r` to **select** the autocomplete suggestion.
3. After another **300 ms** — send `\r` to **submit** the message.

```
text  →  [400ms]  →  \r (select)  →  [300ms]  →  \r (submit)
```

Implemented in `packages/server/src/api/wsHandler.ts`, `terminal:inject` handler.  
Both PTY and bridge paths follow this sequence when `extraEnter: true`.

## Where to Look If It Regresses

- `wsHandler.ts` — `terminal:inject` block. Check the `extraEnter` branch.
- `InjectionInput.tsx` — sets `extraEnter: true` when the text contains an `@` mention (image paste path).
- Server logs: look for `[inject] extra-enter bridge step1 (select)` and `step2 (submit)`.
- If both steps log `ok=true` but text still sits unsubmitted, the timing may need adjustment (increase the 400 ms or 300 ms delays).
