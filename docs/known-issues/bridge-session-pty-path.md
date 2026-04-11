# Bridge Sessions Taking PTY Stdin Path

**Area:** Message injection — bridge sessions  
**Status:** Fixed

## Symptoms

- Injecting a message into a bridge session via the Overlord UI appears to succeed (no error), but nothing appears in the Claude TUI.
- PTY sessions inject correctly; only bridge sessions are affected.
- Server logs show `[inject] pty write ok` for a bridge session — a sign it took the wrong path.

## Root Cause

The inject handler in `wsHandler.ts` first checks whether an active PTY is linked to the session via `claudeToPtyId`. For bridge sessions, a PTY entry **does** exist — it's the display-mirror PTY used to replay terminal output for the Overlord UI. This PTY is read-only for display purposes; writing to its stdin does nothing useful.

The original code had no `!isBridge` guard, so bridge sessions entered the PTY stdin write path instead of the named-pipe path.

## Fix

Added `!isBridge` guard before the PTY path:

```ts
const ptyId = claudeToPtyId.get(sessionId);
if (!isBridge && ptyId && ptyManager.has(ptyId)) {
  // direct PTY stdin write
}
// falls through to bridge pipe inject
```

Implemented in `packages/server/src/api/wsHandler.ts`, `terminal:inject` handler.

## Where to Look If It Regresses

- `wsHandler.ts` — ensure `!isBridge` guard is present before the `ptyManager.write` call.
- `stateManager.isBridge(sessionId)` — returns true when the session was linked via a bridge marker.
- If inject silently succeeds but nothing appears in the TUI, check which path was taken via server logs (`[inject] pty write ok` vs `[inject] session=... bridge=true`).
