# Diagnose Sessions — Reference

Architecture diagrams, known issues, and quick symptom lookup for session diagnostics.

---

## Known Issues & Patterns

### IntelliJ /clear doesn't update session file
When `/clear` is run in an IntelliJ terminal, the session file (named by PID) sometimes doesn't update its `sessionId` field, and no new transcript file appears. The process stays alive. Overlord continues tracking the old session with stale data. **Detection approach:** if a session's transcript stopped being updated >5min ago and the process is alive, it may be a silent /clear. **Mitigation (implemented):** `refreshTranscript()` now tracks a `staleCount` — consecutive polls where `lastActivity` hasn't changed for `working`/`thinking` sessions. After 3 stale checks (~9 seconds), it re-reads the session file to check if the sessionId changed. If it did, the full replacement flow fires (markClosed → session:replaced → transferSessionIdentity).

### `overlord-resume` hides sessions with dead successors (FIXED)
`transferSessionIdentity()` sets `launchMethod = 'overlord-resume'` on old sessions after `/clear` detection. `getSnapshot()` was filtering ALL `overlord-resume` sessions, even when their successor had died or been closed. This caused old/closed sessions to vanish from the UI after a server restart when the successor was no longer alive. **Fix:** only hide `overlord-resume` sessions when their successor session is still alive (not closed).

### Server restart kills Claude sessions (FIXED)
The `restart-server.md` command previously ran `Get-Process -Name 'node' | Stop-Process` which killed ALL node processes including active Claude sessions. **Fix:** the restart command now only kills processes that are listening on ports 3000 and 5173, leaving Claude sessions untouched.

### IDE session PID guard (IMPLEMENTED)
`updateAlivePids()` now checks the transcript file mtime before closing IDE-launched sessions. If the transcript was written to within 60 seconds, the session stays alive even if the wrapper PID is dead. This mitigates the IntelliJ wrapper PID mismatch where the shell wrapper exits but Claude keeps running.

### Dormitory feature removed
Previously, sessions could be placed in a "dormitory" (stored in localStorage) which made them invisible in the main office UI. This was a common cause of "missing sessions" — the session existed in server state but was filtered out client-side by the dormitory filter. The dormitory feature has been completely removed, eliminating this source of confusion.

### Duplicate sessions from transcript loading
On server restart, `loadClosedSessionsFromTranscripts()` scans `.jsonl` files and creates closed sessions. If the same session is also in `known-sessions.json`, and the dedup check fails (e.g., one loaded with slightly different metadata), duplicates appear.

### PTY sessions not linking
When a PTY is spawned from the Overlord UI, a temporary `pty-xxx` ID is created. It links to the real Claude session via three mechanisms (in priority order):
1. **Name marker** (`___OVR:<ptySessionId>` in session file's `name` field) — most reliable
2. **Resume ID** (`pendingPtyByResumeId` for `terminal:resume`) — reliable for resumes
3. **PID matching** (`pendingPtyByPid`) — unreliable on Windows ConPTY due to wrapper PID

If all linking fails, the PTY output goes nowhere and the session shows without a terminal.

### Embedded session spawn flow (name-first)
See "Name-first spawn flow (CURRENT APPROACH)" below for full details. Summary: click "+" → name input → Enter → spawn with `--name` flag. Name is in session file from the first write.

### Stale PTY maps causing phantom Terminal tab (FIXED)
**Root cause:** `claudeToPtyId` / `ptyToClaudeId` maps were not cleaned up when sessions were deleted or removed. On WS reconnect, the server replayed `terminal:linked` for stale entries, causing clients to show a phantom PTY Terminal tab with empty content.

**Fix (implemented):** PTY map cleanup added to:
1. `deleteSession()` — clears `claudeToPtyId`/`ptyToClaudeId` entries and kills the PTY process
2. `sessionWatcher.on('removed')` — clears map entries for removed sessions

### Dynamic `launchMethod` — PTY indicator accuracy (FIXED)
**Root cause:** `launchMethod` was set once at session creation and never updated. This caused inaccurate indicators:
- Session launched via Overlord PTY then resumed externally → still showed "Overlord PTY"
- External session attached via Overlord PTY → never showed PTY indicator
- Running `claude --resume` externally on a closed Overlord PTY session → still showed "Overlord PTY (ended)"

**Fix (implemented):** `launchMethod` is now dynamically updated:
1. **PTY links to session** (any `claudeToPtyId.set()` call) → `setLaunchMethod(sessionId, 'overlord-pty')`
2. **"Open in Terminal" button** (`terminal:open-external` handler) → `setLaunchMethod(sessionId, 'terminal')`
3. **External resume of closed Overlord session** (in `stateManager.addOrUpdate()`) → if session transitions from closed to active with no pending PTY spawn or pending resume, and `launchMethod` was `'overlord-pty'`, it resets to `'terminal'` (or `'ide'` if IDE detected)

**Detection logic for external resume:** `stateManager.addOrUpdate()` checks `wasClosedNowActive && !hasPendingPty` where `hasPendingPty = pendingPtySpawns.has(cwd) || hasPendingResume(cwd)`. If neither Overlord PTY spawn nor Overlord resume is pending, the session was resumed externally.

**UI indicators updated:**
- DetailPanel "Launched from" field shows dynamic state with green/gray status dots
- Terminal tab shows "PTY (ended)" with gray badge for dead PTY connections
- Terminal ended notice shows "Resume in new PTY" reattach button
- Details tab shows "Connect" section (with "Attach in Overlord" / "Attach in Terminal" buttons) for active sessions, "Resume" section for closed sessions

### Empty ghost sessions from /clear detection (FIXED)
When `/clear` fires, the old session is replaced by a new one. Previously, the old session was always marked `closed` and kept in the UI. But if the old session had no transcript (e.g., it was a brief interim session), it appeared as an empty ghost — no conversation, no useful data.

**Fix (implemented):** `closeOrRemoveReplaced()` helper checks if the old session has a transcript via `findTranscriptPathAnywhere()`. If yes, marks closed (preserves conversation history). If no, removes entirely. Applied to all 5 `/clear` detection paths: PID-based, CWD-based, in-place (changed handler), transcript-based, and stale transcript.

### Name-first spawn flow (CURRENT APPROACH)
The UI flow for spawning new embedded sessions is name-first:
1. User clicks "+" → name input appears in Room
2. User types name and presses Enter
3. THEN spawn happens with `--name "<userName>___OVR:<ptySessionId>"`
4. Session file immediately has the name baked in via `--name` flag

**Why name-first:** Previously, spawn happened immediately on click and the name was saved client-side only (localStorage). This was unreliable — the session file was created before the name could be applied, so it showed as a UUID. The `--name` flag ensures the name is in the session file from the first write.

**Name marker stripping:** `stateManager.addOrUpdate()` strips `___OVR:` marker from `raw.name` before using it as `proposedName`. Empty names (when no user name provided) fall through to other name sources (transcript `proposedName`, parent session name).

### External terminal sessions also get --name flag
When "Open in Terminal" (`terminal:open-external`) or "New Terminal" (`terminal:open-new`) is used, the CLI is now spawned with `--name "<sessionName>"` so the name persists in the session file. Previously, external terminal sessions had no name tracking.

### Transcript-based PID guard extended to ALL sessions (CHANGED)
Previously, the transcript-mtime guard in `updateAlivePids()` only applied to IDE sessions (`launchMethod === 'ide'` or `ideName` set). Now it applies to ALL sessions. If the transcript was written within 120 seconds, the session stays alive regardless of PID status. This catches more wrapper-PID scenarios beyond just IDE.

**Changed from:** 60s threshold for IDE-only → **120s threshold for all sessions**

### Large transcript files causing session termination (FIXED)
**Root cause:** `readTranscriptState()` used `fs.readFileSync()` to read the ENTIRE transcript file every 3 seconds per active session. Long-running sessions accumulate transcripts of 15-25MB+. Reading these synchronously every 3s caused:
1. Node.js event loop blocking during 25MB read + parse
2. File handle contention on Windows — overlord holds a read handle while Claude Code tries to append
3. After enough write contention, Claude Code's process errors out and exits

**Symptoms:**
- Claude sessions started from the overlord directory exit after a couple of minutes
- Terminal stays open but `claude` process terminates
- Happens more with long-running/resumed sessions (larger transcripts)

**Fix (implemented in `transcriptReader.ts`):**

1. **Tail-read:** `readFileTail()` reads only the last 512KB of the file using `fs.openSync()` + `fs.readSync()` with position offset. The activity feed only needs the last ~500 lines.

2. **Incremental compaction scanning:** `detectCompactionIncremental()` caches compaction count by file size cursor. Only scans new bytes appended since last check, with a quick `string.includes('compact_boundary')` pre-filter before JSON parsing.

3. **Dirty-flag system:** Chokidar `change` events call `markTranscriptDirty(filePath)`. The 3s polling interval skips file I/O entirely for non-dirty files — just re-evaluates time-based state (`working`/`thinking`/`waiting`) from a cached `stateHint`.

4. **Three-tier read optimization:**
   - **Fast path** (no I/O): file not dirty + checked <1s ago → arithmetic on cached `stateHint` + `fileModifiedMs`
   - **Medium path** (stat only): not dirty + stat shows same mtime/size → re-eval state from time
   - **Slow path** (tail-read): dirty or file changed → `stat()` + tail-read 512KB + incremental compaction

5. **`readProposedName()` optimization:** Reads only first 64KB (the first user message is always near the top) instead of the full file.

**Impact:** For idle sessions, the 3s poll does zero file I/O. For active 25MB transcripts, reads 512KB instead of 25MB — a 50x reduction.

### IDE wrapper PID mismatch
IntelliJ launches Claude through a shell wrapper. The PID in the session file is the wrapper, not the node process. When the wrapper dies (e.g., terminal tab closed), `processChecker` marks the session closed even though the Claude process may still be running. The 30-second grace period and transcript-mtime check now applies to all sessions (not just IDE), mitigating this broadly.

### ConPTY PID mismatch breaks PTY linking on Windows (FIXED)
On Windows, `node-pty` spawns processes through ConPTY, which creates a wrapper process. The PID reported by `node-pty` (`pid-ready` event) is the ConPTY wrapper PID, NOT the actual `claude.exe` PID. Claude writes its own PID to the session file (`~/.claude/sessions/{pid}.json`). Since the PIDs differ, the PID-based linking in `pendingPtyByPid` never matches, and the PTY session fails to link to the real Claude session.

**Symptoms:**
- PTY terminal shows garbled output (minified JS, stack traces)
- `ptyToClaudeId` / `claudeToPtyId` maps are empty after resume
- Session appears as `launch: ide` instead of `overlord-pty`
- Phantom closed sessions with `launch: overlord-pty` appear
- Session name not applied (shows UUID instead of user-provided name)

**Fix (implemented — multi-layer):**

1. **Name marker linking (PRIMARY — most reliable):** All PTY spawn paths (`terminal:spawn`, `terminal:resume`, `terminal:clone`) pass `--name "<displayName>___OVR:<ptySessionId>"` to the CLI. The session file's `name` field contains this marker. When the session watcher fires `added` or `changed`, the handler checks `raw.name` for `___OVR:`, extracts the ptySessionId, and links via `ptyManager.has(marker)`. This completely bypasses PID matching. The `___OVR:` suffix is stripped from `proposedName` in `stateManager.addOrUpdate()` so it never shows in the UI.

   **Key timing detail:** Claude CLI writes the session file WITHOUT the `name` field initially, then updates it with `name` shortly after. So `added` fires with `name=NONE` and `changed` fires with the marker. Both handlers have the marker check. PID-based linking may succeed on `added`, and the marker acts as a fallback on `changed` if PID linking failed.

2. **`pendingPtyByResumeId` (for resumes):** When `terminal:resume` spawns Claude, it stores `{ ptySessionId, ws, timestamp }` keyed by the resume session ID. The session watcher matches `raw.sessionId` against this map. This works for resumes where the session ID is predictable (reuses target ID).

3. **PID-based linking (legacy fallback):** Still in place via `pendingPtyByPid`. Works when ConPTY wrapper PID happens to match (sometimes it does). Includes a 500ms retry mechanism gated by `hasPendingResume(raw.cwd)`.

**Cleanup:** Stale `pendingPtyByResumeId` entries cleaned up every 60s and on PTY exit. Name marker linking has no cleanup needed — it's stateless (checks `ptyManager.has()` at match time).

### Interim phantom from `claude --resume` (FIXED)
When `claude --resume <targetId>` starts, it first creates a session file (`{pid}.json`) with a TEMPORARY UUID, then rewrites it to the target session ID. The session watcher catches both states: `added` (temp UUID) then `changed` (real UUID). Without mitigation, the temp UUID creates a phantom session visible in the UI for a brief moment, which also gets persisted to `known-sessions.json`.

**Symptoms:**
- Two sessions with the same name appear briefly after resume
- Phantom closed session with `launch: overlord-pty` and `resumedFrom` pointing to the real session
- Ghost sessions reappearing after server restart (persisted in known-sessions.json)

**Fix (implemented):** Three-layer defense:
1. **Skip interim in `added` handler:** If there's a `pendingPtyByResumeId` entry for this CWD's resume target, and `raw.sessionId != target`, skip registration entirely — but only if the interim has no transcript (safety guard).
2. **Link PTY in `changed` handler:** When the session file settles to the real UUID, `pendingPtyByResumeId` matches and links the PTY correctly.
3. **Remove phantom in `changed` handler:** If /clear detection finds an old session whose `resumedFrom === raw.sessionId`, it's an interim phantom — `remove()` it entirely instead of `markClosed()`.

### `claude --resume` exits with code 1 for non-deferred sessions (HISTORICAL — FIXED)
When `claude --resume <id>` is called on a session that has no pending/deferred tool call (e.g., a cloned session or an idle session), Claude CLI exits immediately with:
`Error: No deferred tool marker found in the resumed session. Either the session was not deferred, the marker is stale (tool already ran), or it exceeds the tail-scan window. Provide a prompt to continue the conversation.`

The PTY process dies after ~2.7s (exit code 1), triggers ConPTY retry logic (up to 4 attempts), all fail. Each failed spawn creates temporary session files that can trigger false /clear detection.

**Symptoms:**
- Session appears briefly as `working` then goes back to `closed`
- Multiple `[PtyManager] PTY exited after Xms (code 1), retrying` log messages
- `AttachConsole failed` errors in server log (ConPTY side effect)
- Terminal tab is blank or missing

**Fix (implemented):** The PTY resume handler now passes `'continue'` as a prompt argument: `['--resume', rootSessionId, 'continue']`. This satisfies Claude CLI's requirement for a prompt when no deferred tool marker exists.

### False /clear detection during PTY resume (FIXED)
When a PTY resume spawns Claude and it fails/retries, each attempt creates temporary session files. The CWD-based and transcript-based /clear detection paths incorrectly match these interim sessions to unrelated sessions in the same CWD, causing session merging (one session's transcript gets assigned to another).

**Symptoms:**
- Session conversation shows messages from a different session
- Session names/transcripts get swapped after resume attempt
- Multiple sessions in same CWD get marked as "replaced"

**Fix (implemented):** All three /clear detection paths (PID-based, CWD-based, transcript-based) now check `hasActiveResumeInProgress()` (which returns `pendingPtyByResumeId.size > 0`). If a PTY resume is in flight, /clear detection is suppressed to prevent false matches.

### Blank PTY terminal after resume — missing client notification (FIXED)
`migratePtyMaps()` updates server-side PTY routing maps when a session UUID changes (e.g., interim → real ID), but did NOT notify the client. The client's output handlers remained registered under the old session ID while the server sent output under the new ID. Result: blank terminal.

**Symptoms:**
- Terminal PTY tab is completely blank (no output)
- Or Terminal PTY tab doesn't appear at all (isPtySession returns false)
- Server PTY maps show correct linking but client doesn't know

**Fix (implemented):** `migratePtyMaps()` now broadcasts `terminal:session-replaced` to all clients after updating the maps. The client's `useTerminal` hook handles this message type via `migrateId()`, moving output handlers and ptySessionIds to the new session ID.

### Multiple tabs kill PTY sessions on disconnect (FIXED)
When multiple browser tabs connect to Overlord (`localhost:5173`), each tab has its own WebSocket connection. The `ws.on('close')` handler was calling `ptyManager.kill()` on ALL PTY sessions in the closing connection's `wsSessionMap`. When any tab refreshed, navigated away, or closed, it killed all PTY sessions linked to that tab — even if the user was actively using the terminal in another tab.

Additionally, PTY events (`terminal:spawned`, `terminal:output`, `terminal:exit`) were sent only to the WS client that initiated the spawn. Other tabs couldn't see or interact with the terminal.

**Symptoms:**
- PTY session dies shortly after being created (especially with multiple tabs open)
- Terminal PTY tab is blank in one tab but worked briefly in another
- Session goes from `working` to `closed` unexpectedly after tab refresh
- `AttachConsole failed` errors in server log (red herring — the real cause was WS close killing the PTY)

**Fix (implemented):**
1. Removed `ptyManager.kill()` from `ws.on('close')` — PTY sessions now survive tab disconnections
2. Changed all PTY events to broadcast via `broadcastRaw()` instead of `sendToClient()` — all tabs receive terminal data

### Blank Terminal PTY on Page Refresh/Reconnect (FIXED)
**Root cause:** The server broadcasts PTY output in real-time but does not buffer it. When a new WS client connects (page refresh, new tab), the server correctly replays `terminal:linked` messages (so the Terminal PTY tab appears), but there's no output to display — the xterm mounts empty.

**Fix (implemented):** Added server-side PTY output ring buffer (`ptyOutputBuffer` in index.ts):
- Each PTY's output is stored in a ring buffer (max 500 chunks)
- On new WS connection, buffered output is replayed as a single `terminal:output` message after `terminal:linked`
- Buffer is cleaned up on PTY exit
- Output uses `claudeSessionId` (not `ptySessionId`) to match client expectations

### Terminal PTY Tab Not Appearing Without Refresh (FIXED)
**Root cause:** The `terminal:linked` broadcast message is sent to all connected WS clients. If the client's WS connection was temporarily disconnected during the broadcast, it would miss the message. On reconnect, the server's replay loop in `wss.on('connection')` sends `terminal:linked` for all active PTYs, which correctly populates `ptySessionIds` via `migrateId()` in useTerminal.ts.

**Key insight:** The `migrateId(oldId, newId)` function in useTerminal.ts always adds `newId` to `ptySessionIds` regardless of whether `oldId` was present. So even if the client missed `terminal:spawned`, receiving `terminal:linked` is sufficient for the tab to appear.

**Additional fix:** Added `replay: true` flag to replayed `terminal:linked` messages to prevent the `onSpawned` callback from auto-opening the DetailPanel on reconnect.

### Garbled Terminal PTY Output on Clone Resume (FIXED — was CLI Bug)
**Status:** Fixed by switching to `--fork-session`. The info below is preserved for reference.

**Root cause:** `claude --resume <sessionId> continue` crashes in PTY/interactive mode (TTY detected) but works in piped mode. The CLI's React/Ink TUI renderer crashes when resuming a session, producing a minified JavaScript stack trace from `cli.js` (React internals like `Symbol.for("react.memo_cache_sentinel")`).

**Evidence:**
- `claude --resume <id> "hi"` in piped bash → works, returns response
- `claude --resume <id> --print "say OK"` → works perfectly
- Same command spawned via node-pty (TTY) → crashes with stack trace from `B:/~BUN/root/src/entrypoints/cli.js`
- New sessions (`claude` with no args) work fine in PTY → crash is specific to `--resume` code path
- Tested workarounds: `--fork-session`, `TERM=xterm-256color`, `TERM=dumb` — none prevent the crash

**Previous wrong assumption:** "Not a bug, just conversation history." WRONG — it's a Claude CLI TUI crash, not history output.

**Workaround needed:** This is an upstream Claude CLI bug. Possible future workarounds:
1. Run `claude --resume` in print mode, capture response, then start fresh interactive session
2. Wait for CLI fix
3. Use non-PTY conversation view (which reads transcripts directly) instead of PTY for resumed sessions

**Impact:** Resume via PTY terminal shows garbled stack trace. The Conversation tab (reading transcripts directly) still works correctly for resumed sessions.

**Resolution:** Replaced manual transcript copy + `--resume <cloneId>` with `claude --resume <originalId> --fork-session`. The CLI handles forking natively — no transcript manipulation, no TUI crash.

### Clone via --fork-session (CURRENT APPROACH)
Clone uses `claude --resume <originalId> --fork-session --name "<cloneName>___OVR:<ptySessionId>"`:
- The CLI reads the original session's transcript for conversation history
- Creates a new session ID automatically for future writes
- No manual transcript copying or sessionId rewriting needed
- Clean TUI output, no crashes
- Clone name and ptySessionId marker baked into `--name` flag for reliable linking

**Activity feed for clones:** The forked session initially has no transcript. Overlord sets `resumedFrom` on the forked session (via `pendingCloneInfo` map applied after PTY linking), which triggers the transcript fallback in `stateManager.refreshTranscript()` — reads the parent's transcript for the activity feed.

**Clone name:** Stored in `pendingCloneInfo` map (keyed by ptySessionId) alongside `originalSessionId`. Applied via `applyPendingCloneInfo()` after PTY links (sets `proposedName` and `resumedFrom`, then calls `refreshTranscript()`). The name is also embedded in the `--name` flag so it persists in the session file and survives server restarts.

**PTY linking for clones:** `--fork-session` creates an unpredictable new session ID, so `pendingPtyByResumeId` can't match. PID-based linking is unreliable due to ConPTY wrapper PID mismatch. The name marker (`___OVR:<ptySessionId>`) in the session file is the primary linking mechanism — checked in both `added` and `changed` handlers.

**Previous broken approaches:**
1. Manual transcript copy + sessionId rewrite → CLI TUI still crashed in PTY mode
2. Buffer suppression (skip first 5s of output) → crash output still showed live
3. Client-side xterm clear on link → didn't address root cause
4. CWD-based fallback linking → false positives when multiple sessions share same cwd

### Console Screen Reading: Daemon Queue Flooding (FIXED)

**Symptom:** Console Preview shows empty content or rotating content from wrong sessions. Text injection from Overlord to terminal sessions stops working (messages don't appear).

**Root cause:** The PowerShell injector daemon (`inject.ps1`) processes commands serially (~500ms per screen read). The permission checker used `setInterval(3s)` sending reads for ALL sessions. Cycles overlapped, flooding the daemon's `pending` queue to 30+ entries. This caused:
1. Screen reads timing out → API returning empty/stale data
2. Inject commands blocked behind dozens of reads → injection unresponsive

**Fix (in `consoleInjector.ts` + `permissionChecker.ts`):**
1. Serialized read queue: only ONE read command in the daemon at a time (`readBusy` flag + `drainReadQueue()`)
2. Inject commands bypass the read queue — go directly to daemon stdin
3. Per-PID deduplication in the read queue (same PID queued twice → piggyback)
4. 5s cache TTL to reduce redundant reads
5. Permission checker converted from `setInterval` to non-overlapping `setTimeout` after completion

**Files:** `packages/server/src/pty/consoleInjector.ts`, `packages/server/src/session/permissionChecker.ts`

### Optimistic Message Display: Count-Based De-duplication

**Context:** When user sends messages via the Overlord conversation UI, they appear immediately as "pending" before the transcript confirms them.

**Problem with content matching:** De-duplication by content (`Set` of known user messages) fails when sending duplicate text ("yes", "yes", "yes") — all get matched to a single transcript entry and disappear. Count-based matching (counting occurrences) also fails when the transcript already has many matching messages from previous interactions.

**Solution:** Count-based approach tracking real feed growth:
- On first send, snapshot how many user messages exist in the real activity feed (`realCountAtFirstSend`)
- Each new real user message "confirms" one local message from the front
- `pendingMessages = localSent.slice(confirmed)` — only unconfirmed messages shown
- When all confirmed, reset tracking

**File:** `packages/client/src/components/DetailPanel.tsx`

### Console Screen Reading: Pending Queue Response Mismatch (FIXED)

**Symptom:** Console Preview shows content rotating between sessions — every few seconds, different session content appears in the same preview panel.

**Root cause:** The PowerShell injector daemon (`inject.ps1`) processes commands sequentially via stdin/stdout. Node.js tracks responses in a FIFO `pending` array. When a `readScreen` call times out (3s), it was removing its entry from `pending`. But the daemon still sends a response for that request. That orphaned response then gets matched to the NEXT request in the queue — delivering wrong session's content.

**Fix (in `consoleInjector.ts`):**
1. Timed-out entries stay in `pending` — the timeout just resolves the Promise early with `null`, but the entry remains to consume the daemon's eventual late response
2. Added per-PID cache with 2s TTL to deduplicate concurrent reads
3. Client-side `ConsolePreview.tsx` verifies `data.sessionId` matches the requested session

**File:** `packages/server/src/consoleInjector.ts` — `doReadScreen()` function

### Console Screen Reading: Per-Session Isolation (VERIFIED)
**Question:** Does `AttachConsole(claudePid)` return per-session content, or do IDE/ConPTY sessions share a console and return mixed content?

**Answer: Per-session isolation works correctly.** Tested with `test-screen-isolation.ps1` — every active session (terminal, IDE, overlord-pty) returns unique screen content via `AttachConsole(pid)`.

**How it works on Windows:**
- Each Claude session gets its own ConPTY pseudo-console, backed by a unique `conhost.exe` instance
- `AttachConsole(claudePid)` correctly resolves to that session's specific conhost
- `NtQueryInformationProcess(pid, ProcessConsoleHostProcess=49)` can resolve the conhost PID — confirmed each session maps to a different one
- IDE terminal sessions (VS Code, JetBrains) also get unique conhosts despite running under the same IDE process

**When it fails:**
- `AttachConsole` returns error when the process is dead (PID no longer exists)
- The persistent PowerShell daemon may occasionally return empty if the attach/free cycle has state issues — transient, retrying usually works

**Diagnostic test scripts** (in `packages/server/src/`):
- `test-conhost.ps1` — resolves console host PID per session, tests both direct and conhost-based screen reading
- `test-screen-isolation.ps1` — reads screen for all active sessions and cross-compares to verify uniqueness

**UI integration:** The `ConsolePreview` component in DetailPanel's Conversation tab polls `GET /api/sessions/:id/screen` every 4s when expanded. Shows raw console output for non-PTY sessions. Collapsible, hidden for PTY/closed sessions. Falls back silently on failure.

---

## Architecture: PTY Output Flow
```
claude.exe (ConPTY) → node-pty → ptyManager.emit('output') → index.ts handler:
  1. Buffer output in ptyOutputBuffer (ring buffer, 500 chunks)
  2. Base64-encode
  3. Broadcast as terminal:output to ALL connected WS clients
  4. On new connection: replay from buffer after terminal:linked
```

## Architecture: /clear Detection Paths
```
5 independent detection paths, all using closeOrRemoveReplaced():

1. PID-based (added handler):
   New session file with same PID as existing session → replacement
   Guard: !linkedToPty && !hasActiveResumeInProgress()

2. CWD-based (added handler):
   New session in same CWD as recently-removed session (within 30s)
   Guard: !linkedToPty && !replacedByPid && !hasPendingResume(cwd) && !hasActiveResumeInProgress()

3. In-place (changed handler):
   Session file's sessionId changed (same PID file, new UUID)
   Guard: startupComplete

4. Transcript-based (transcript watcher, handleTranscriptAdded):
   New transcript file appears for unknown session in CWD with existing active sessions
   Guard: !hasActiveResumeInProgress()

5. Stale transcript (60s interval):
   Active session's session file has different sessionId than expected → re-read detected change
   Guard: staleCount >= 3 (consecutive polls with unchanged lastActivity)

All paths:
  - Call closeOrRemoveReplaced(oldSessionId) — removes if no transcript, closes if has one
  - Call transferName() to carry display name to new session
  - Call migratePtyMaps() to reroute terminal output
  - Broadcast session:replaced to clients
```

## Architecture: Console I/O for Non-PTY Sessions
```
Two independent channels via consoleInjector.ts (persistent PowerShell daemon → inject.ps1):

INPUT (inject):
  POST /api/sessions/:id/inject { text } → consoleInjector.injectText(pid, text)
  → PowerShell WriteConsoleInput() → keystrokes injected into session's console input buffer
  Used for: permission responses, interrupt (Escape), force stop (Ctrl+C), sending messages

OUTPUT (read):
  GET /api/sessions/:id/screen → consoleInjector.readScreen(pid)
  → PowerShell ReadConsoleOutput() → reads visible screen buffer (25 lines)
  Used for: permission prompt detection (permissionChecker), diagnostic peek

Both use the same persistent PowerShell daemon process for performance.
Only works on Windows (returns null/no-op on other platforms).
```

---

## Architecture: Bridge Mode (Named Pipe Relay)

Bridge mode spawns Claude in a separate console window via the Go bridge binary (`packages/bridge/overlord-bridge.exe`). Unlike embedded PTY sessions (where node-pty owns the ConPTY), bridge sessions have their own independent ConPTY that survives Overlord server restarts.

### Data Flow
```
User's console window ←→ overlord-bridge.exe (ConPTY owner)
                              ↕ named pipe (\\.\pipe\overlord-brg-XXXXXXXX)
                         Overlord server (two sockets per bridge):
                           - INPUT socket  → sends keystrokes to bridge → child
                           - OUTPUT socket ← receives ConPTY output broadcast
                              ↕ WebSocket
                         Client (xterm.js in PTY Terminal tab)
```

### Bridge Binary (`packages/bridge/`)
- **Entry point:** `main.go` — creates ConPTY child, named pipe listener, stdin→child forwarding
- **Windows console setup:** `vt_windows.go` — `enableVTProcessing()`, `setRawInputMode()`, `syncConsoleDimensions()`
- **Unix stubs:** `vt_stub.go` — no-op functions for cross-platform compilation
- **ConPTY child:** `pty_windows.go` — `startChildWithPty()` creates ConPTY with detected dimensions (120×30), returns `writeToChild` func
- **Stderr:** Redirected to `%TEMP%/overlord-bridge.log` at start of `main()` to prevent console corruption
- **Build:** `powershell -Command "Set-Location 'C:\projekty\overlord\packages\bridge'; & 'C:\Program Files\Go\bin\go.exe' build -o overlord-bridge.exe . 2>&1"`

### Handshake Protocol
Every pipe connection starts with a 6-byte handshake read by the bridge:
- `INPUT\n` → **Input-only**: pipe reads forwarded to child via `writeToChild()`, NOT added to broadcast list
- `OUTPT\n` → **Output-only**: added to broadcast client list, blocks draining reads (no input forwarding)
- Anything else → **Legacy bidirectional**: first bytes forwarded to child, added to broadcast

**Why dual sockets:** A single bidirectional socket causes output backpressure to block injection writes, and output data received by the input path gets garbage-forwarded to the child as null bytes.

### Server-Side Connection (`connectBridgePipe` in `index.ts`)
```
1. Connect INPUT socket → send "INPUT\n" → register in bridgeManager (for injection)
2. Connect OUTPUT socket → send "OUTPT\n" → receive broadcast output → buffer + broadcast as terminal:output
3. On output connect: broadcast terminal:linked to clients
4. On disconnect: reconnect after 2s (output socket only)
5. On connect error: remove from bridge registry (pipe dead)
```

### Session Matching
Bridge sessions use `___BRG:<marker>` name markers (NOT CWD-based matching):
1. UI spawns bridge: `overlord-bridge.exe --pipe overlord-brg-XXXXXXXX -- claude --name "UserName___BRG:brg-XXXXXXXX"`
2. Claude writes session file with `name` field containing `___BRG:brg-XXXXXXXX`
3. `linkPendingBridge()` in `sessionEventHandlers` detects marker, calls `connectBridgePipe()`
4. `stateManager.addOrUpdate()` strips `___BRG:` suffix from `proposedName`

### Persistence Across Server Restarts
- **Bridge registry:** `%TEMP%/overlord-bridge-registry.json` maps `{sessionId → pipeName}`
- `registerBridgePipe()` / `unregisterBridgePipe()` maintain the file
- `reconnectBridgePipes()` called on server startup — reads registry, reconnects to all known pipes
- Dead pipes (connect error) are automatically removed from registry

### Output Buffering & Replay
- Server buffers bridge output in `ptyOutputBuffer` (same ring buffer as PTY sessions, 500 chunks max)
- On new WS connection: server replays `terminal:linked` + buffered output for all bridge sessions
- On view switch (xterm remount): client sends `terminal:replay` message → server replays buffer
- Bridge sessions keyed by `sessionId` directly (not ptySessionId)

### Console Setup (Windows)
- **Raw input mode:** Disables `ENABLE_LINE_INPUT` (0x0002) and `ENABLE_ECHO_INPUT` (0x0004), enables `ENABLE_VIRTUAL_TERMINAL_INPUT` (0x0200) — keystrokes go directly to ConPTY
- **Dimension sync:** `syncConsoleDimensions()` — move cursor to (0,0), shrink window to 1×1, set buffer to exact size (120×30), expand window to match
- **VT processing:** `enableVTProcessing()` — enables `ENABLE_VIRTUAL_TERMINAL_PROCESSING` on stdout for ANSI escape sequences

### Conversation Injection for Bridge Sessions
- Overlord Conversation UI sends `terminal:inject` with text
- `wsHandler.ts` detects bridge session via `bridgeSessions.has(sessionId)`
- Always appends `\r` (carriage return) for bridge sessions: `text + '\r'`
- Writes via `bridgeManager.write(sessionId, data)` → INPUT socket → bridge → child ConPTY

### Client-Side Bridge Detection
- `useTerminal.ts` tracks `bridgeSessionIds` ref
- On `terminal:linked` with `ptySessionId` starting with `bridge-`, adds `claudeSessionId` to set
- `isBridgeSession(id)` callback passed to DetailPanel
- Bridge terminals rendered with `fixedSize={{ cols: 120, rows: 30 }}` (matching ConPTY dimensions)

### NUDGE and RSNUD Protocols (ConPTY Redraw)

Bridge sessions use two additional one-shot pipe protocols for triggering redraws without sending input:

- **`NUDGE\n`** (6 bytes): Bridge calls `nudgeRedraw()` — resizes ConPTY by +1 col and back, forcing a full repaint. Bridge closes connection immediately after.
- **`RSNUD\n`** (6 bytes header, then `"cols rows\n"` payload): Bridge reads the size string, resizes ConPTY to those exact dimensions, then nudges. Used when xterm.js size (120×30) differs from the terminal that started the bridge (e.g., IntelliJ at 145×21).

**Why RSNUD is needed:** The bridge starts with whatever dimensions the host terminal has. If the user opens the Overlord PTY Terminal tab (xterm at 120×30), the ConPTY content renders at the wrong width, causing misaligned text and cursor. RSNUD resizes the ConPTY to match xterm, then triggers a full repaint so everything renders correctly.

**Server trigger:** `resizeAndNudgeBridgePipe(sessionId, cols, rows)` in `pipeInjector.ts`. Called 400ms after the output socket connects (the initial nudge from `OUTPT\n` connection fires at the wrong size; the delayed RSNUD corrects it). Also called from `terminal:replay` handler with client's current cols/rows.

**TypeScript implementation (`pipeInjector.ts`):**
```typescript
socket.write(`RSNUD\n${cols} ${rows}\n`, (err) => {
  if (err) { resolve(false); return; }
  socket.end();  // Use end(), NOT destroy() — graceful FIN lets bridge read both header + payload
});
```

**Go implementation (`main.go`):**
```go
if n == 6 && string(header[:6]) == "RSNUD\n" {
    sizeBuf := make([]byte, 32)
    sn, _ := conn.Read(sizeBuf)
    var newCols, newRows int
    fmt.Sscanf(string(sizeBuf[:sn]), "%d %d", &newCols, &newRows)
    resizeAndNudge(newCols, newRows)
    conn.Close()
    return
}
```

**CRITICAL: `socket.end()` not `socket.destroy()`**. `destroy()` sends TCP RST which may abort the connection before the bridge finishes reading the header. `end()` sends FIN, allowing the bridge to complete reading before closing.

### Pipe Address Mismatch: `pipeAddrs` Map

`pipePath(sessionId)` generates `\\.\pipe\overlord-<full-uuid>` but manually-started bridges listen on `\\.\pipe\overlord-<8char-marker>` (e.g., `overlord-brg-abc123`). NUDGE/RSNUD one-shot connections were silently failing because they connected to the wrong pipe address.

**Fix:** `BridgeConnectionManager` maintains a `pipeAddrs: Map<string, string>`. `connectBridgePipe()` calls `bridgeManager.setPipeAddr(sessionId, pipeAddr)` **synchronously** (before the `net.connect()` call) so the address is available immediately for any `terminal:replay` that arrives before the async connect callback fires.

**Critical timing:** If `setPipeAddr()` is called inside the connect callback (async), a `terminal:replay` arriving before connect completes will fall back to the wrong `pipePath(sessionId)` address. Move it before `net.connect()`.

### Bridge Binary Must Be Rebuilt After Go Changes

The bridge binary (`overlord-bridge.exe`) is a compiled Go binary. Changes to `.go` files in `packages/bridge/` do NOT take effect until the binary is rebuilt. This is a common source of confusion — code looks correct but old behavior persists.

**Symptom of stale binary:** NUDGE/RSNUD text appears in the terminal output as literal characters (`RSNUD`, `120 30`). The old binary (without the protocol handlers) treats RSNUD connections as legacy bidirectional clients and forwards the bytes to the child process as keyboard input.

**Rebuild command:**
```powershell
Set-Location 'C:\projekty\overlord\packages\bridge'
& 'C:\Program Files\Go\bin\go.exe' build -o overlord-bridge.exe .
```
Or from bash:
```bash
cd C:/projekty/overlord/packages/bridge && "/c/Program Files/Go/bin/go.exe" build -o overlord-bridge.exe .
```

**After rebuild:** Restart any bridge sessions so they pick up the new binary (existing bridge processes continue using the old binary — you must start a new one).

### Double Cursor in Bridge Terminal (FIXED)

Bridge sessions render two visible cursors: one from the ConPTY output (Claude's own cursor character in the terminal output stream), and one from xterm.js's own cursor rendering.

**Root cause:** xterm.js renders a block cursor at the current cursor position. With `cursor: 'transparent'`, the cursor block has a transparent background but may still be visible depending on xterm.js version. Meanwhile, Claude's terminal renders its own cursor character as part of the ConPTY output.

**Fix:** For bridge sessions (`fixedSize` prop set), use `cursor: '#0d1117'` (background color) instead of `'transparent'`. This makes xterm's cursor block identical to the background — fully invisible. The ConPTY output is solely responsible for cursor rendering.

**In `XtermTerminal.tsx`:**
```typescript
cursor: fixedSize ? '#0d1117' : 'transparent',
```

**Why internal PTY sessions are unaffected:** Internal PTY sessions don't emit their own visible cursor characters — xterm's cursor IS the cursor, and `'transparent'` makes it look like the character at that position with normal colors. Bridge sessions have TWO cursors competing.

### Known Limitations
- Bridge window title shows `___BRG:` marker (cosmetic — not yet fixed)
- Messages sent while Claude is "working" may be lost (ConPTY buffers but Claude TUI may discard stdin during processing)
- Bridge binary must be rebuilt manually after Go code changes (`go build`) — stale binary causes RSNUD bytes to appear as terminal input

---

## Quick Symptom Reference

| Symptom | Most Likely Cause | Where to Check |
|---|---|---|
| Session visible in files, missing from UI | Server lost watcher event | Step 3 cross-reference |
| Session stuck as `idle` but process alive | PID check failed; process restarted with new PID | Step 4 PID check |
| Session stuck as `working` forever | Transcript not updating; file watcher stalled | Step 6 transcript freshness |
| New session appeared after `/clear` | `/clear` creates a new sessionId | Step 5 orphan check |
| Duplicate sessions in UI | Two `.json` files with same `cwd`, or dedup failure on restart | Step 2 file list |
| PTY terminal not connecting | wsSessionMap / PTY link failed | Step 7 PTY state |
| Ghost session in server, no file | Session file deleted; server not notified | Step 3 cross-reference |
| Old/closed sessions missing from UI after restart | `overlord-resume` filter hiding sessions with dead successors | Step 3 cross-reference + check `launchMethod` |
| PTY terminal shows garbled output after resume | ConPTY PID mismatch — PTY linked to wrong session or not linked at all | Check `ptyToClaudeId`/`claudeToPtyId` maps in debug endpoint |
| Two sessions with same name after resume | Interim phantom from `claude --resume` temp UUID | Check `known-sessions.json` for duplicates, verify skip-interim log |
| Session goes back to closed immediately after resume | `claude --resume` requires prompt for non-deferred sessions | Check server log for "No deferred tool marker" or exit code 1 |
| Session conversation shows messages from different session | False /clear detection during PTY resume | Check for `hasActiveResumeInProgress` guard, verify `/clear:detected` logs |
| Terminal PTY tab blank or missing | `migratePtyMaps` not notifying client | Check `claudeToPtyId` maps match client's `ptySessionIds` |
| PTY dies when refreshing or switching tabs | Multiple WS connections — tab close kills PTY sessions | Check if multiple localhost:5173 tabs are open |
| Terminal PTY tab blank after page refresh | No PTY output buffer — server only streams real-time | Check `ptyOutputBuffer` in index.ts, verify replay on connect |
| Terminal PTY tab not appearing without refresh | Client missed `terminal:linked` broadcast during WS disconnect | Verify `terminal:linked` replay in `wss.on('connection')` handler |
| Phantom PTY Terminal tab (empty, not ended) | Stale `claudeToPtyId` entry replayed on WS reconnect | Restart server to clear maps; fix ensures cleanup on delete/remove |
| PTY indicator stays after external resume | `launchMethod` was static, now dynamic | Check `setLaunchMethod` calls in index.ts; verify `addOrUpdate` reset logic |
| "Attach in Overlord" doesn't update indicator | `setLaunchMethod` missing on PTY link path | Verify `claudeToPtyId.set()` is followed by `setLaunchMethod('overlord-pty')` |
| Terminal shows "garbled" text (minified JS, markdown) | Was misdiagnosed — actually a CLI TUI crash on resume. Fixed via --fork-session | Inspect raw CLI output; this is expected behavior |
| Garbled JS/stack trace in Terminal PTY after resume | Fixed — clone now uses --fork-session, no crash | Check that clone uses `--fork-session` flag |
| Session name shows UUID instead of user-provided name | Name not passed via `--name` flag at spawn time, or marker stripping failed | Check session file for `name` field; verify spawn uses name-first flow |
| Clone name not applied | `applyPendingCloneInfo` never fired — PTY linking failed | Check `pendingCloneInfo` map, verify name marker in session file |
| Empty ghost session after /clear | Old session had no transcript but was kept as closed | Should auto-remove via `closeOrRemoveReplaced()`; check if transcript exists |
| Claude process exits after a few minutes | Large transcript file causing I/O contention | Check transcript `.jsonl` file sizes — files >10MB cause issues if tail-read optimization is missing |
| Console Preview rotates between sessions | Pending queue response mismatch in consoleInjector | Check `doReadScreen()` timeout handling, verify per-PID cache |
| Console Preview empty or injection blocked | Daemon queue flooded | Check `pending` count in server logs; restart server |
| Bridge Terminal PTY tab empty | Output socket missing `OUTPT\n` handshake — bridge blocks on `conn.Read()` | Check bridge log at `%TEMP%/overlord-bridge.log`; verify `connectBridgePipe` sends `OUTPT\n` |
| Bridge Terminal PTY tab goes blank on view switch | xterm disposed on unmount, no replay on remount | Verify `terminal:replay` message sent by client and handled by server |
| Bridge conversation injection not arriving | Input socket not connected, or missing `\r` append | Check bridge log for `pipe→child` messages; verify `INPUT\n` handshake |
| Bridge session not detected after spawn | `___BRG:` marker missing from session name | Check session file `name` field; verify `linkPendingBridge` in index.ts |
| Bridge session lost after server restart | Bridge registry file missing or stale | Check `%TEMP%/overlord-bridge-registry.json`; verify `reconnectBridgePipes()` |
| Null bytes sent to bridge child process | Output data forwarded on input socket (pre-handshake bug) | Verify dual-socket with `INPUT\n`/`OUTPT\n` handshake protocol |
| `RSNUD` / `120 30` text appears as input in bridge terminal | Stale bridge binary — rebuilt before NUDGE/RSNUD handlers existed | Rebuild binary: `cd packages/bridge && go build -o overlord-bridge.exe .` |
| Bridge terminal cursor/content misaligned (wrong width) | ConPTY started at host terminal size (e.g., 145×21), xterm is 120×30 | RSNUD is sent 400ms after output socket connects; check server log for `[bridge] RSNUD result: ok` |
| RSNUD/NUDGE fails silently (connection succeeds but bridge ignores it) | Wrong pipe address — `pipePath(sessionId)` ≠ actual bridge pipe name | Check `pipeAddrs` Map; verify `setPipeAddr()` called synchronously in `connectBridgePipe` before `net.connect()` |
| Bridge Terminal PTY empty — `terminal:clear` received but no `terminal:output` ever follows | Output socket disconnected; reconnect blocked by input socket guard (`bridgeManager.isConnected` = true) | Fixed: output socket reconnects via `connectBridgeOutputSocket()` which bypasses the input-socket guard |
| Bridge Terminal PTY empty — bridge alive but ConPTY reader dead (zombie bridge) | ConPTY read pipe broke ("Potok został zakończony" / pipe terminated) while child still alive. Bridge stuck in `waitForChild()`, pipe accepts connections but output goroutine exited. | Server health check: 10s after output socket connects, if no data → marks bridge DEAD and cleans up. Bridge binary: `readerDead` channel causes exit(2) when read goroutine dies. Check `%TEMP%/overlord-bridge.log` for `read error` or `ConPTY reader exited`. Kill stale bridge process and restart. |
| Bridge registry corruption — multiple sessions mapped to same pipe | Manual bridge restart or session re-linking caused duplicate entries in `%TEMP%/overlord-bridge-registry.json` | Fixed: `reconnectBridgePipes()` deduplicates on startup — keeps canonical session (whose ID appears in pipe name), removes stale duplicates |
| Two visible cursors in bridge terminal | xterm.js cursor + ConPTY cursor both visible | Fixed by `cursor: fixedSize ? '#0d1117' : 'transparent'` in XtermTerminal.tsx |