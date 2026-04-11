# Queued Messages That Never Arrive

**Area:** Message injection — client / WebSocket  
**Status:** Fixed

## Symptoms

- User sends a message via the Conversation panel. It appears with a "queued" badge but never shows up in the transcript.
- Badge disappears after 60s. Message is silently lost.
- Happens intermittently, especially when the UI reconnects or the connection was briefly interrupted.

## Root Cause

`sendMessage` in `useOfficeData.ts` returned `void` and silently dropped messages when the WebSocket was not in `OPEN` state. Race condition:

1. WebSocket closes
2. React `connected` state is async — not yet `false`
3. User sees textarea enabled and sends a message
4. `sendMessage` checks `wsRef.current.readyState !== OPEN` → silently drops
5. `localSent` gets a "queued" entry but the server never received anything
6. 60s timeout clears the badge — message is lost

## Fix

`sendMessage` now returns `boolean` (`true` = sent, `false` = dropped). `injectText` in `useTerminal.ts` checks the return value — if `false`, sets a `sessionErrors` entry: `"Not connected – message not sent. Try again."` This error is shown in DetailPanel below the message input. `handleSend` in DetailPanel only adds to `localSent` (shows "queued") when `injectText` returns `true`.

**Files changed:**
- `packages/client/src/hooks/useOfficeData.ts` — `sendMessage: (msg: object) => boolean`
- `packages/client/src/hooks/useTerminal.ts` — `injectText` propagates boolean, sets error on false
- `packages/client/src/components/DetailPanel.tsx` — `handleSend` gates `localSent` on return value

## Where to Look If It Regresses

- `useOfficeData.ts` — verify `sendMessage` still returns `boolean`.
- `useTerminal.ts` — `injectText` must propagate the boolean and set `sessionErrors` on `false`.
- Browser console: look for a silent send with no server-side `[inject]` log entry.
