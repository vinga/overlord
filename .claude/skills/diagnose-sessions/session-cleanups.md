# Session Cleanup & /clear Detection — Architecture Notes

## How Session Replacement Works

When a session is replaced (e.g. after `/clear`), the server:

1. Calls `stateManager.transferName(oldId, newId)` — copies `proposedName` and `colorOverride` to new session
2. Calls `migratePtyMaps(ctx, oldId, newId, pid)` — transfers `claudeToPtyId` / `ptyToClaudeId` entries
3. Calls `stateManager.markDeleted(oldId)` — removes old session and prevents re-registration from stale session file
4. Broadcasts `{ type: 'session:replaced', oldSessionId, newSessionId }` — client migrates custom names, room order, and selected session

---

## /clear Detection Mechanisms (in priority order)

### 1. UI injection — `pendingClearReplacement` (most reliable)
- **Trigger:** User clicks Clear button or injects `/clear` via Overlord InjectionInput
- **How:** `wsHandler.ts` calls `stateManager.markPendingClearReplacement(sessionId, cwd)` before injecting
- **Detection:** `transcriptWatcher.ts` `handleTranscriptAdded` → `consumePendingClearReplacement(cwd)` → matches by CWD key
- **Works for:** All session types (bridge, PTY, IDE)
- **Limitation:** Only works when /clear goes through Overlord's UI, not when typed directly in terminal

### 2. Embedded PTY marker — `___OVR:<ptyId>` (reliable for Overlord-spawned terminals)
- **Trigger:** New session file appears with `___OVR:<marker>` in its name
- **How:** `sessionEventHandlers.ts` `added` / `changed` handlers detect the marker and check `ptyToClaudeId`
- **Detection:** If a different session was previously linked to same `ptyId`, it's treated as a replacement
- **Works for:** Sessions spawned by Overlord's embedded PTY (Terminal tab)
- **Limitation:** Does NOT persist across `/clear` — Claude doesn't preserve `--name` flags after clear

### 3. Terminal-typed /clear, unique CWD — transcript content + length=1 guard (conservative)
- **Trigger:** New transcript has `<command-name>/clear</command-name>` in first 20 lines
- **How:** `transcriptWatcher.ts` searches for bridge or PTY sessions in same CWD
- **Detection:** Only replaces if exactly 1 bridge session OR exactly 1 PTY session in same CWD
- **Works for:** Unambiguous cases — single bridge or PTY per project directory
- **Limitation:** Fails when multiple bridge/PTY sessions share the same CWD (common in monorepos)
- **Content format:** `content` can be a plain string OR an array of blocks — both are handled

### 4. Session watcher `changed` event — PID-based detection
- **Trigger:** Session file (`~/.claude/sessions/{pid}.json`) is updated in-place with a new `sessionId`
- **How:** `sessionEventHandlers.ts` `changed` handler detects when sessionId changes but PID stays same
- **Detection:** Old sessionId → new sessionId replacement
- **Works for:** Cases where the same process restarts with a new session

---

## Bridge Session Restart Survival

### Problem (fixed 2026-04-09)
After a server restart, bridge sessions loaded from `known-sessions.json` stayed `state: 'closed'` even when the bridge pipe successfully reconnected and the process was still alive. Root cause:

- `loadKnownSessions()` pre-populates all sessions as `state: 'closed'` (correct — they might be dead)
- `reconnectBridgePipes()` calls `stateManager.setSessionType(id, 'bridge')` then `connectBridgePipe()`
- The bridge connects successfully, but **`transcriptWatcher` and `processChecker` both skip `closed` sessions**
- Result: session stays `closed` forever despite being alive

### Fix
`stateManager.reviveClosedSession(sessionId)` is called in the input socket `connect` callback inside `connectBridgePipe()`. If the session is `closed` at that point, it's revived to `waiting` so `transcriptWatcher` and `processChecker` can take over.

```
connectBridgePipe → input socket connects → reviveClosedSession → 'waiting'
↓
transcriptWatcher / processChecker → updates to real state (working/thinking/waiting)
```

### Limitation
If the bridge registry has a **stale session ID** (e.g. `/clear` was not detected, so `migrateBridgeSession` was never called), the registry maps `old-id → pipe-name`. On restart, `reconnectBridgePipes` reconnects under the old ID. If the old session ID is not in `known-sessions`, `reviveClosedSession` is a no-op. The new session remains `closed`.

---

## What Does NOT Work

| Scenario | Why it fails |
|---|---|
| Typing `/clear` in bridge terminal when multiple bridge sessions share same CWD | `bridgeMatches.length > 1` → no replacement |
| Typing `/clear` in IntelliJ when multiple IDE sessions share same CWD | No PTY tracking, and CWD-only matching is disabled |
| `parentUuid` matching | The `/clear` entry's `parentUuid` points to a message in the SAME new transcript, not the old session |
| Transcript mtime matching | Too aggressive — picks wrong session when multiple are active simultaneously |
| Bridge session restart when /clear was not detected | Registry still maps `old-id → pipe`, new session stays `closed` after reconnect |

## What Gets Preserved on Replacement

| Field | Mechanism | Where |
|---|---|---|
| Session name (proposedName) | `stateManager.transferName()` | Server |
| Worker color | `stateManager.colorOverrides` map, set in `transferName()` | Server |
| Custom user name | `useCustomNames.migrateSession()` on `session:replaced` | Client localStorage |
| Room position / drag order | `useRoomOrder.migrateSession()` on `session:replaced` | Client localStorage |
| Selected session in UI | `handleSessionReplaced` in App.tsx | Client state |
| PTY terminal link | `migratePtyMaps()` in sessionEventHandlers | Server Maps |
| Bridge output routing | `bridgeIdOverrides.set(oldId, newId)` | Server Map (follows chain for multiple /clears) |

---

## Key Files

| File | Role |
|---|---|
| `packages/server/src/session/transcriptWatcher.ts` | /clear detection via transcript content + CWD matching |
| `packages/server/src/session/sessionEventHandlers.ts` | /clear detection via `___OVR:` marker and PID-based session file change |
| `packages/server/src/session/stateManager.ts` | `transferName()`, `colorOverrides`, `markPendingClearReplacement()` |
| `packages/server/src/index.ts` | `migrateBridgeSession()`, `bridgeIdOverrides` chain following |
| `packages/client/src/App.tsx` | `handleSessionReplaced` → calls `migrateNames` + `migrateRoomOrder` |
| `packages/client/src/hooks/useCustomNames.ts` | `migrateSession()` for custom names in localStorage |
| `packages/client/src/hooks/useRoomOrder.ts` | `migrateSession()` for room drag order in localStorage |

---

## Debug Tips

- Check `[clear:detected]` log lines to confirm detection fired
- Check `[pending-clear]` logs to trace the pending-clear mechanism
- `bridgeSessions` set in `/api/debug/state` shows which sessions have active bridge connections
- `claudeToPtyId` / `ptyToClaudeId` in `/api/debug/state` show PTY→Claude session linkage
- If session disappears instead of being replaced: check if `mtime` detection is matching wrong session (was reverted, but watch for regressions)
- If new session appears with name `<local-command-caveat>Caveat:...`: /clear was typed directly in terminal AND CWD is ambiguous (multiple sessions) — use Overlord's UI to inject /clear instead