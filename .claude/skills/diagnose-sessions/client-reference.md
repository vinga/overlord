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

---

## Terminal Tab

### Black panel / partial content when switching back to Terminal tab (FIXED)

**Symptom:** Click Terminal tab → full history visible. Switch to Conversation tab and back → black screen or only the last user message + status bar is shown.

**Root cause:** `XtermTerminal` was conditionally rendered (`{activeTab === 'terminal' && ...}`). On tab switch, React unmounts and remounts the component. The xterm.js instance is destroyed and recreated, losing all scrollback buffer. On remount, only the last buffered repaint frame (since the last `\x1b[?2026h` checkpoint) is replayed — which for a session in "waiting" state might be just a few lines.

**Fix (implemented):** `XtermTerminal` is now always mounted for live PTY/bridge sessions, toggled via `display: none / flex` rather than conditional rendering. The xterm instance (and its 5000-line scrollback buffer) survives tab switches.

**Files changed:**
- `packages/client/src/components/DetailPanel.tsx` — terminal section changed from `{activeTab === 'terminal' && (...)}` to always-rendered div with `style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}`
- `packages/client/src/components/XtermTerminal.tsx` — output handler registered immediately on mount (not deferred to after fit), so output accumulates in scrollback even while hidden; `tryFit()` called via ResizeObserver which fires when `display:none → flex` transition occurs

**Key insight:** ResizeObserver fires when an element transitions from `display:none` to a visible display value (since dimensions go from 0 to positive). This triggers `fitAddon.fit()` and the SIGWINCH nudge automatically when the terminal tab is opened, without any manual polling.

---

### Terminal too small / content rendering at wrong dimensions (FIXED)

**Symptom:** Terminal shows partial content, blank lines, or misaligned TUI layout. Resizing the browser window or the terminal's parent container fixes it.

**Root cause (initial fit too early):** The old `doFit` rAF loop registered the output handler with `80×24` (xterm default) dimensions if the container wasn't visible yet. This caused `terminal:replay` to be sent with wrong dimensions, Claude repainted at `80×24`, and the terminal showed a fragment until a second resize arrived.

**Root cause (spinning rAF while hidden):** When the terminal was always mounted but hidden, the `doFit` retry loop would spin at 60fps until the tab was opened.

**Fix (implemented):**
1. Output handler registered immediately with current dimensions (even `80×24`) so output flows into scrollback
2. `tryFit()` is called via ResizeObserver — first successful fit re-registers the handler with correct dimensions and sends `terminal:replay` at the real size
3. No more spinning rAF loop — ResizeObserver handles the visibility-change fit

---

### Bridge sessions: blank terminal on macOS (FIXED)

**Symptom:** Bridge session's Terminal tab is blank or shows only a few lines. Resizing Terminal.app would sometimes help, but `terminal:replay` didn't restore content.

**Root cause:** `conpty_unix.go` was a stub that used simple `io.Pipe` with no real PTY. `nudgeRedraw` and `resizeAndNudge` were no-ops. Without a real PTY, SIGWINCH couldn't be sent to the child process, so Claude Code's TUI never repainted.

**Fix (implemented):** Replaced stub with a real PTY using `github.com/creack/pty`. Initial size is inherited from the parent terminal via `unix.IoctlGetWinsize(os.Stdin.Fd(), TIOCGWINSZ)`. `resizeAndNudge` calls `pty.Setsize()` + `unix.Kill(pid, SIGWINCH)`. The bridge binary must be rebuilt after changes to `conpty_unix.go`.

**Files changed:**
- `packages/bridge/conpty_unix.go` — full rewrite using `creack/pty`
- `packages/bridge/go.mod` — added `github.com/creack/pty v1.1.24`

---

### Bridge session name duplication (`___BRG:xxx___BRG:yyy`) (FIXED)

**Symptom:** Opening a bridge terminal (via "Open in Terminal" or "Open Bridged") creates a Claude command with a doubled marker in the `--name` flag, e.g. `--name "Felix___BRG:old-id___BRG:new-id"`.

**Root cause:** `proposedName` on the session already contains a `___BRG:` marker from the previous bridge link. When constructing the new command, the marker was appended again without stripping the old one.

**Fix (implemented):** `stripInternalMarkers()` helper in `wsHandler.ts` strips all `___BRG:xxx` and `___OVR:xxx` suffixes before constructing `sessionName` for both `terminal:open-external` and `terminal:open-bridged` handlers.

```typescript
function stripInternalMarkers(name: string): string {
  return name.replace(/___(?:BRG|OVR):[A-Za-z0-9_-]*/g, '').replace(/[-_\s]+$/, '').trim();
}
```

**File changed:** `packages/server/src/api/wsHandler.ts`

---

### Terminal.app window opens too small (FIXED)

**Symptom:** "Open in Terminal" opens Terminal.app at default (small) size, causing TUI content to be clipped or wrapped incorrectly.

**Fix (implemented):** The AppleScript in `openTerminalWindow()` (`packages/server/src/index.ts`) sets `number of columns to 160` and `number of rows to 50` after opening the window.
