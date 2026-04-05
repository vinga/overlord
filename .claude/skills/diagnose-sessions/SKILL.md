# Diagnose Session Issues

Run all session diagnostic checks automatically and produce a summary report. Diagnoses: missing sessions, ghost sessions, stuck states, orphaned transcripts, /clear detection failures, PTY linking issues, duplicate sessions, and PID mismatches.

**This is an automated skill. Run every check below without asking, then produce the summary table at the end.**

---

## Step 1 — Gather Server State

Hit the debug endpoint and capture the full state:

```bash
curl -s http://localhost:3000/api/debug/state
```

If the server is not running, note it and skip server-dependent checks.

Also capture the live WebSocket snapshot to compare what clients actually see:

```bash
cd C:/projekty/overlord && node -e "
const ws = require('ws');
const client = new ws('ws://localhost:3000');
client.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'snapshot') {
    console.log(JSON.stringify(msg, null, 2));
    client.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT - no snapshot received'); process.exit(1); }, 5000);
"
```

Compare the debug endpoint sessions with the WebSocket snapshot sessions. They should match. Differences indicate a broadcast bug.

---

## Step 2 — Enumerate Session Files on Disk

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
const fileIds = new Map();
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    fileIds.set(d.sessionId, { pid: d.pid, file: f, cwd: d.cwd || d.workingDirectory });
  } catch {}
}
console.log('Session files on disk:', fileIds.size);
for (const [sid, info] of fileIds) {
  console.log('  ', sid.slice(0,8), '| pid:', info.pid, '| file:', info.file, '| cwd:', info.cwd);
}
"
```

---

## Step 3 — Cross-Reference Session Files vs Server State

Compare session files on disk with what the server tracks. Report:
- **In files but NOT in server** -> server lost track (watcher missed event, or session created before server start)
- **In server but NOT in files** -> phantom/ghost session (loaded from transcript or known-sessions.json, or file deleted without notification)
- **In both** -> healthy

---

## Step 4 — Check Process Liveness

For each tracked session, verify the PID is alive:

```bash
node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    const pid = d.pid;
    if (!pid) continue;
    let alive = false;
    try {
      const out = execSync('tasklist /FI \"PID eq ' + pid + '\" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
      alive = out.includes(String(pid));
    } catch {}
    console.log('PID', pid, '|', d.sessionId.slice(0,8), '| alive:', alive);
  } catch {}
}
"
```

**Red flags:**
- PID dead but session shows as working/thinking/waiting -> processChecker failed or 30s grace period active
- PID alive but session shows as closed/idle -> PID mismatch (common with IntelliJ wrapper processes)
- Session is `idle` when process is clearly alive -> PID check failed or process restarted with new PID

---

## Step 5 — Find /clear Artifacts (Orphaned Transcripts)

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const sessDir = path.join(home, '.claude', 'sessions');
const sessionIds = new Set();
for (const f of fs.readdirSync(sessDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    if (d.sessionId) sessionIds.add(d.sessionId);
  } catch {}
}
const projDir = path.join(home, '.claude', 'projects');
let orphanCount = 0;
for (const slug of fs.readdirSync(projDir).filter(d => fs.statSync(path.join(projDir, d)).isDirectory())) {
  const dir = path.join(projDir, slug);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const sid = f.replace('.jsonl', '');
    if (!sessionIds.has(sid)) {
      const stat = fs.statSync(path.join(dir, f));
      const age = (Date.now() - stat.mtimeMs) / 60000;
      if (age < 120) {
        orphanCount++;
        console.log('ORPHAN:', sid.slice(0,8), '| age:', age.toFixed(1) + 'm | size:', stat.size, '| slug:', slug.slice(0,30));
      }
    }
  }
}
if (orphanCount === 0) console.log('No recent orphaned transcripts found.');
"
```

**What orphans mean:**
- Transcript with no matching session file -> created before `/clear` (the OLD conversation)
- If a new transcript appeared at roughly the same time -> `/clear` happened, detection may have worked
- If NO new transcript appeared -> `/clear` didn't create a new session properly (IDE session issue)

---

## Step 6 — Check Transcript Freshness

For every active (non-closed) session, check if its transcript is being updated:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const projDir = path.join(home, '.claude', 'projects');
const http = require('http');
http.get('http://localhost:3000/api/debug/state', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const state = JSON.parse(data);
    for (const s of state.sessions) {
      if (s.state === 'closed') continue;
      const slugDirs = fs.readdirSync(projDir).filter(d => fs.statSync(path.join(projDir, d)).isDirectory());
      for (const slug of slugDirs) {
        const tp = path.join(projDir, slug, s.sessionId + '.jsonl');
        if (fs.existsSync(tp)) {
          const stat = fs.statSync(tp);
          const age = (Date.now() - stat.mtimeMs) / 60000;
          const flag = age > 5 && s.state !== 'waiting' ? ' STALE' : '';
          console.log(s.sessionId.slice(0,8), '|', s.state, '| transcript age:', age.toFixed(1) + 'm' + flag);
        }
      }
    }
  });
}).on('error', () => console.log('Server not reachable, skipping transcript freshness check.'));
"
```

**Red flags:**
- Session is `working` or `thinking` but transcript hasn't been modified in >5 minutes -> stale state, likely /clear happened
- Session is `waiting` but transcript is very old -> normal (waiting for user input)

---

## Step 7 — Read Console Screen Buffer

For non-PTY sessions, read the actual console screen content via the screen-read endpoint. This shows what the user would see in the terminal — including permission prompts, TUI state, and tool output that may NOT appear in the transcript.

```bash
# Read console screen for a specific session
curl -s http://localhost:3000/api/sessions/SESSION_ID/screen | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).text))"
```

**Use this to:**
- Verify permission prompt text matches what `permissionChecker` detected
- See post-interrupt state (after sending Escape via inject endpoint)
- Debug sessions stuck in `working` state — the console may show an error or prompt not captured by transcript
- Compare console output with transcript to find discrepancies

**How it works:** Uses `readScreen(pid)` from `consoleInjector.ts` which reads the Windows console screen buffer via a persistent PowerShell daemon (`inject.ps1`). Same mechanism used by `permissionChecker.ts`. Only works on Windows.

**Endpoint:** `GET /api/sessions/:sessionId/screen` → `{ text: string }` (returns 400 if closed, 404 if not found)

---

## Step 8 — Check PTY State (Indirect)

The debug endpoint does not expose the PTY map or `wsSessionMap` directly. To check PTY state indirectly:

```bash
tasklist /FO CSV /NH | grep -i node
```

Cross-reference node processes with tracked PIDs. Look for:
- Sessions in `wsSessionMap` that don't exist in `stateManager` -> linking failed
- PTY sessions with no corresponding session file -> leaked PTY

If deeper PTY diagnostics are needed, suggest adding a temporary debug log to `packages/server/src/ptyManager.ts`.

---

## Step 9 — Summary Report

After running all checks, produce this summary table:

| Check | Status | Details |
|-------|--------|---------|
| Server running | pass/fail | |
| WebSocket snapshot matches debug state | pass/fail/skipped | |
| Sessions tracked (server) | N | |
| Session files on disk | N | |
| File-Server mismatches | N | list any |
| Dead PIDs (non-closed sessions) | N | list any |
| Orphaned transcripts (<2h old) | N | list any |
| Stale transcripts (active but >5m old) | N | list any |
| /clear detection failures | N | session file unchanged but transcript stale |
| Suspected PTY leaks | N | list any |

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
**Root cause:** `readTranscriptState()` used `fs.readFileSync()` to read the ENTIRE transcript file every 3 seconds per active session. Long-running sessions accumulate transcripts of 15–25MB+. Reading these synchronously every 3s caused:
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
1. **Skip interim in `added` handler:** If there's a `pendingPtyByResumeId` entry for this CWD's resume target, and `raw.sessionId ≠ target`, skip registration entirely — but only if the interim has no transcript (safety guard).
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

### Quick Symptom Reference

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

### Architecture: PTY Output Flow
```
claude.exe (ConPTY) → node-pty → ptyManager.emit('output') → index.ts handler:
  1. Buffer output in ptyOutputBuffer (ring buffer, 500 chunks)
  2. Base64-encode
  3. Broadcast as terminal:output to ALL connected WS clients
  4. On new connection: replay from buffer after terminal:linked
```

### Architecture: /clear Detection Paths
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

### Architecture: Console I/O for Non-PTY Sessions
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