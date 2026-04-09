# Session Cleanup & /clear Detection — Architecture Notes

## How Session Replacement Works

When a session is replaced (e.g. after `/clear`), the server:

1. Calls `stateManager.transferSessionState(oldId, newId)` — copies `proposedName`, `colorOverride`, `bridgePipeName`, `bridgeMarker`, `ptySessionId`, `sessionType`, and sets `resumedFrom`
2. Calls `migratePtyMaps(ctx, oldId, newId, pid)` — transfers `claudeToPtyId` / `ptyToClaudeId` entries
3. Marks old session as replaced (`replacedBy` field) and closed, adds to deleted list
4. Broadcasts `{ type: 'session:replaced', oldSessionId, newSessionId }` — client migrates custom names, room order, and selected session
5. Calls `saveKnownSessions()` to persist the new state for restart survival

---

## /clear Detection — Unified PID-Based Approach

**Spec:** `specs/clear-detection-simplification.md`

**Key invariant:** When Claude's `/clear` runs, the PID stays the same. The session file (`{pid}.json`) updates in-place with a new sessionId. A new transcript `.jsonl` is created.

### Detection Path 1: Live — Session File `changed` Event (PRIMARY)
- **Where:** `sessionEventHandlers.ts` `changed` handler
- **How:** Session file updates in-place → chokidar fires `changed` → handler reads new sessionId → `findSessionByPid()` finds old session with same PID but different sessionId → replacement flow
- **Works for:** All cases where the server is running when `/clear` happens

### Detection Path 2: Periodic — Stale Transcript Poll
- **Where:** `transcriptWatcher.ts` periodic 3s interval
- **How:** `refreshTranscript()` returns `transcriptStale: true` when transcript hasn't been updated but PID is alive → re-reads `{pid}.json` → if sessionId changed, triggers replacement
- **Works for:** Cases where the `changed` event was missed (race condition, file system lag)

### Detection Path 3: Startup — PID File Comparison
- **Where:** `stateManager.detectClearOnStartup()`, called from `index.ts` after `sessionWatcher.start()`
- **How:** For each known session with active PID, reads `{pid}.json` from disk → if sessionId differs from stored sessionId → `/clear` happened while server was down → `transferSessionState()`
- **Works for:** Server-was-down cases where the session file already has the new sessionId when server starts

### Detection Path 4: UI-Injected /clear — Pending Clear Mechanism
- **Where:** `transcriptWatcher.ts` `handleTranscriptAdded` → `consumePendingClearReplacement()`
- **How:** When user clicks Clear in Overlord UI, `wsHandler.ts` records `pendingClearReplacement(sessionId, cwd)` before injecting `/clear`. When new transcript appears, pending entry is consumed for exact match.
- **Works for:** /clear initiated through Overlord's UI (not guessing — explicit)

### What Was Removed (2026-04-09)
These mechanisms were removed because they raced, overlapped, and caused cascading bugs:
- **Startup orphan scan** — 3s setTimeout scanning transcript files for stale sessions by slug directory
- **Transcript content /clear detection** — scanning first 20 lines of new transcripts for `<command-name>/clear</command-name>` and CWD-matching to find replacement candidate
- **Bridge marker suffix matching** — scanning bridge registry for marker suffixes in `linkPendingBridge`
- **CWD-based fallback** in `sessionEventHandlers.ts` `added` handler — `recentlyRemovedByCwd` map matching
- **`serverStartTime` guard** — no longer needed without transcript content scanning
- **`recentlyRemovedByCwd` map** — fully removed

**Do NOT re-add CWD-based detection.** If /clear is missed, debug the 3 PID-based paths above.

---

## Bridge Session Restart Survival

Bridge metadata (`bridgePipeName`, `bridgeMarker`) is stored on Session objects and persisted in `known-sessions.json` via `saveKnownSessions()`.

### Restart Flow
1. `loadKnownSessions()` pre-populates sessions as `state: 'closed'`
2. `detectClearOnStartup()` fixes any stale sessionIds from /clear-while-down
3. `reconnectBridgePipes()` reads `bridgePipeName` from session objects and connects
4. `reviveClosedSession()` fires on successful pipe connection → session becomes `waiting`
5. `processChecker` / `transcriptWatcher` update to real state

### Known Pipe Shortcut
On restart, `linkPendingBridge()` checks if the session already has a `bridgePipeName` from known-sessions. If so, uses it directly instead of re-deriving from marker. This prevents pipe name corruption (e.g., `overlord-brg-xxx` vs `overlord-new-xxx`).

---

## What Gets Preserved on Replacement

| Field | Mechanism | Where |
|---|---|---|
| Session name (proposedName) | `transferSessionState()` | Server |
| Worker color | `transferSessionState()` → colorOverride | Server |
| Bridge pipe name | `transferSessionState()` → bridgePipeName | Server |
| Bridge marker | `transferSessionState()` → bridgeMarker | Server |
| Session type (bridge/embedded) | `transferSessionState()` → sessionType | Server |
| PTY session ID | `transferSessionState()` → ptySessionId | Server |
| Custom user name | `useCustomNames.migrateSession()` on `session:replaced` | Client localStorage |
| Room position / drag order | `useRoomOrder.migrateSession()` on `session:replaced` | Client localStorage |
| Selected session in UI | `handleSessionReplaced` in App.tsx | Client state |
| PTY terminal link | `migratePtyMaps()` in sessionEventHandlers | Server Maps |
| Bridge output routing | `migrateBridgeSession()` → bridgeIdOverrides | Server Map |

---

## Key Files

| File | Role |
|---|---|
| `packages/server/src/session/stateManager.ts` | `transferSessionState()`, `detectClearOnStartup()`, `saveKnownSessions()` |
| `packages/server/src/session/sessionEventHandlers.ts` | PID-based /clear in `changed` handler, `migratePtyMaps()` |
| `packages/server/src/session/transcriptWatcher.ts` | Stale transcript poll, pending clear for UI |
| `packages/server/src/index.ts` | `reconnectBridgePipes()`, `linkPendingBridge()`, `migrateBridgeSession()` |
| `packages/client/src/App.tsx` | `handleSessionReplaced` → calls `migrateNames` + `migrateRoomOrder` |
| `specs/clear-detection-simplification.md` | Full spec for the unified approach |

---

## Debug Tips

- Check `[clear:detected]` log lines to confirm detection fired
- Check `[clear:startup]` logs for startup PID comparison results
- `bridgeSessions` set in `/api/debug/state` shows which sessions have active bridge connections
- `claudeToPtyId` / `ptyToClaudeId` in `/api/debug/state` show PTY→Claude session linkage
- If session disappears instead of being replaced: check if `transferSessionState` was called and `saveKnownSessions` persisted
- If bridge session lost after restart: check `known-sessions.json` for correct `bridgePipeName`