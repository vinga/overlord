# Diagnose Sessions — Client-Side Reference

Known issues, patterns, and fixes for client-side behavior in Overlord.

---

## Conversation Panel

### "Queued" messages that never arrive (FIXED)

**Symptom:** User sends a message via the Conversation panel. It appears with a "queued" badge but never shows up in the transcript. Badge disappears after 60s.

**Root cause:** `sendMessage` in `useOfficeData.ts` was typed as returning `void` and silently dropped messages when the WebSocket was not in `OPEN` state. Race condition:
1. WebSocket closes
2. React `connected` state is async — not yet `false`
3. User sees textarea enabled and sends a message
4. `sendMessage` checks `wsRef.current.readyState !== OPEN` → silently drops
5. `localSent` gets a "queued" entry but the server never received anything
6. 60s timeout clears the badge — message is lost

**Fix (implemented):** `sendMessage` now returns `boolean` (true = sent, false = dropped). `injectText` in `useTerminal.ts` checks the return value — if false, sets a `sessionErrors` entry: `"Not connected – message not sent. Try again."` This error is shown in DetailPanel below the message input. `handleSend` in DetailPanel only adds to `localSent` (shows "queued") when `injectText` returns `true`.

**Files changed:**
- `packages/client/src/hooks/useOfficeData.ts` — `sendMessage: (msg: object) => boolean`
- `packages/client/src/hooks/useTerminal.ts` — `injectText` propagates boolean, sets error on false
- `packages/client/src/components/DetailPanel.tsx` — `handleSend` gates `localSent` on return value

---

### Pending messages disappear on session switch (FIXED)

**Symptom:** A message is queued (pending badge visible). User switches to another session and back. The queued message is gone from the feed.

**Root cause:** `localSent` (the array of pending/optimistic messages) was reset to `[]` every time `selectedSession` changed in the session-switch `useEffect` in `DetailPanel.tsx`.

**Fix (implemented):** `localSent` and `realCountAtFirstSend` are now stored per-session (like draft text) using `localSentPerSession` and `realCountPerSession` refs (both `Map<sessionId, ...>`). On session switch, pending state is saved for the old session and restored for the new session. When messages are confirmed or timed out, the per-session maps are also cleaned up.

**Files changed:**
- `packages/client/src/components/DetailPanel.tsx` — added `localSentPerSession` and `realCountPerSession` refs; session-switch effect saves/restores instead of clearing

---

## Message Injection Pipeline

End-to-end flow for a message sent from the Conversation tab:

```
DetailPanel.handleSend()
  → injectText(sessionId, text, extraEnter=true)   [useTerminal.ts]
    → sendMessage({ type: 'terminal:inject', ... }) [useOfficeData.ts]
      → WebSocket to server
        → wsHandler.ts: terminal:inject handler
          → claudeToPtyId? → ptyManager.write()         (embedded PTY)
          → isBridge?      → injectViaPipe()             (bridge socket)
          → macOS fallback → injectViaMacTerminal()      (AppleScript)
                           → injectViaCGEvent()           (CGEvent binary)
```

**Diagnosing a stuck message:**
1. Check browser console for `[terminal:inject]` log — did the client send?
2. Check `connected` state in React DevTools — was the WS open?
3. Check server log for `terminal:inject` receipt — did the server get it?
4. Check which injection path was taken (PTY / bridge / mac) and whether it succeeded
5. If bridge: check bridge log at `$TMPDIR/overlord-bridge.log` for `pipe→child` lines

---

## Optimistic Pending Messages

The conversation feed shows messages optimistically before server confirmation.

**How it works:**
- `localSent: string[]` — messages added client-side, shown as "pending" in the feed
- `realCountAtFirstSend` — snapshot of the real user message count when the first pending message was sent
- **Confirmation:** when `currentUserCount > realCountAtFirstSend`, the server feed has caught up → `localSent` is cleared
- **Timeout:** 60s safety net clears stale pending messages if confirmation never comes

**What can prevent confirmation:**
- Injection failed silently (now caught by boolean return — see above)
- Server received the message but Claude is compacting / session is `isCompacting`
- Bridge pipe is dead — message sent to server but not forwarded to Claude's stdin
- Message arrived but the transcript watcher missed the update (stale chokidar)
