# Diagnose Sessions — Client-Side Reference

Known client-side issues have been moved to [`docs/known-issues/`](/docs/known-issues/README.md).

## Quick links

- [Queued messages silently lost](../../../docs/known-issues/queued-messages-lost.md)
- [Pending messages disappear on session switch](../../../docs/known-issues/pending-messages-lost-on-session-switch.md)
- [@file autocomplete consumes \\r on inject](../../../docs/known-issues/at-file-autocomplete-enter-race.md)
- [Terminal tab black / partial on tab switch](../../../docs/known-issues/terminal-tab-black-on-switch.md)
- [Bridge sessions blank terminal on macOS](../../../docs/known-issues/bridge-blank-terminal-macos.md)
- [Bridge session name duplication](../../../docs/known-issues/bridge-session-name-duplication.md)

---

## Message Injection Pipeline

End-to-end flow for a message sent from the Conversation tab:

```
DetailPanel.handleSend()
  → injectText(session.overlordId, text, extraEnter=true)   [useTerminal.ts]
    → sendMessage({ type: 'terminal:inject', sessionId: ovrId }) [useOfficeData.ts]
      → WebSocket to server
        → wsHandler.ts: terminal:inject handler
          → getActiveClaudeByOvr(ovrId) → claudeSessionId, pid
          → ovrToPty.get(ovrId)?  → ptyManager.write()    (embedded PTY)
          → isBridge(claudeId)?   → injectViaPipe()        (bridge socket)
          → macOS fallback        → injectViaMac()         (AppleScript)
                                  → injectText()            (ConPTY)
```

**ovrId routing:** All terminal messages (input, inject, resize, kill, replay) use `session.overlordId` as `sessionId`. This is a stable ID that persists across `/clear`, compaction, and PTY restarts — so the terminal panel keeps working even when the Claude session UUID changes underneath.

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
- Injection failed silently (now caught by boolean return)
- Server received the message but Claude is compacting / session is `isCompacting`
- Bridge pipe is dead — message sent to server but not forwarded to Claude's stdin
- Message arrived but the transcript watcher missed the update (stale chokidar)
