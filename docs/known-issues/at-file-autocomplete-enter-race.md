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

## Secondary Bug: extraEnter hardcoded true for all messages

`DetailPanel.handleSend()` was calling `injectText(sessionId, text, true)` unconditionally — even for plain text with no `@` reference. This caused:

1. Plain text sent to TUI without `\r`
2. After 400 ms: `\r` submitted the message correctly
3. After 700 ms: a second `\r` submitted an **empty message**, disturbing the session

Users perceived this as a ~400 ms delay before their message sent ("enter felt swallowed").

## Fix

### Three-step inject sequence when `extraEnter=true`

```
text  →  [400ms]  →  \r (select)  →  [300ms]  →  \r (submit)
```

1. Send **text only** — no `\r`. Let the TUI render the autocomplete dropdown.
2. After **400 ms** — send `\r` to **select** the autocomplete suggestion.
3. After another **300 ms** — send `\r` to **submit** the message.

### extraEnter gating

`extraEnter` is now derived from `text.includes('@')` — only true when the message actually contains a file reference. Plain text uses immediate `text + '\r'`.

Set in `DetailPanel.handleSend()`:
```ts
const sent = injectText(sessionId, full, full.includes('@'));
```

### Extracted to injectScheduler.ts

The timing logic was extracted from `wsHandler.ts` into `packages/server/src/pty/injectScheduler.ts`:

- `shouldUseExtraEnter(text)` — returns `text.includes('@')`
- `scheduleInject(write, isAlive, text, extraEnter)` — handles both paths, guards against PTY death between steps

`wsHandler.ts` now calls `scheduleInject(...)` instead of inlining the setTimeout chain.

## Image Paste Flow

1. User pastes image → client POSTs base64 to `/api/paste-image` → server saves to `os.tmpdir()` → returns `{ path, previewUrl }`.
2. On send, client appends `@${path}` to text → `extraEnter=true` → three-step sequence fires.
3. **Known limitation:** Claude Code's `@file` autocomplete searches relative to the session CWD. Absolute temp paths (e.g. `/var/folders/…` on macOS) may not surface in autocomplete; whether Claude Code resolves them without autocomplete selection is untested.

## Note: InjectionInput.tsx is unused

`InjectionInput.tsx` is a standalone component that is **not rendered anywhere**. The active injection UI lives inline in `DetailPanel.tsx` (`sendInput2` state + `handleSend`). The docs previously referenced `InjectionInput.tsx` as the source of `extraEnter` — that was incorrect.

## Where to Look If It Regresses

- `packages/server/src/pty/injectScheduler.ts` — `scheduleInject()` and `shouldUseExtraEnter()`.
- `packages/server/src/api/wsHandler.ts` — `terminal:inject` block. Verify `scheduleInject` is called.
- `packages/client/src/components/DetailPanel.tsx` — `handleSend()`. Verify `extraEnter = full.includes('@')`.
- Server logs: look for `[inject] extra-enter pty step1 (select)` and `step2 (submit)`.
- If both steps log `ok=true` but text still sits unsubmitted, the timing may need adjustment (increase the 400 ms or 300 ms delays).
- Tests: `packages/server/src/__tests__/injectScheduler.test.ts` — covers both plain-text and `@file` paths including PTY death guards.
