# Server Performance Optimizations

Reference guide for understanding and maintaining Overlord server startup performance.

## Startup Bottleneck History

Original startup time: **~20 seconds**. After optimizations: **~3 seconds**.

### Root Causes Found (April 2026)

1. **Per-PID PowerShell calls** (~18s)
   - `isSpawnedByOverlord()`, `isChildOfIde()`, `detectIdeFromProcessChain()` each spawned a new `powershell.exe` via `execSync`
   - Each PowerShell invocation costs ~1-2s on Windows (module loading: "Preparing modules for first use")
   - Called per-session during startup, up to 3 calls each × 10 sessions = ~30 PowerShell invocations

   **Fix:** `getAllProcessInfo()` in `stateManager.ts` — one `Get-CimInstance Win32_Process` call fetches ALL process info at startup. Chain walks then use the in-memory snapshot. On macOS/Linux, uses `ps -eo pid,ppid,comm`.

2. **Subagent transcript reading** (~3-5s)
   - `readSubagents()` in `transcriptReader.ts` called `readTranscriptState()` for every subagent file
   - Session `b32d32ef` had 250 subagent files, each read at startup even if inactive
   - Most subagents are >10 min old and would be filtered out after reading

   **Fix:** Check file mtime BEFORE calling `readTranscriptState()` — skip files older than 10 minutes (the filter threshold). Avoids reading hundreds of stale subagent transcripts.

3. **Haiku worker transcript accumulation**
   - AI classifier spawns `claude --model haiku` in `~/.claude/overlord/haiku-worker/`
   - Session files are cleaned up on exit, but `.jsonl` transcripts in `~/.claude/projects/{slug}/` are never deleted
   - Accumulated ~3,000 files (~28MB) that slow down directory scans

   **Fix:** `cleanupOldWorkerTranscripts()` in `claudeQuery.ts` — runs on startup, deletes `.jsonl` files older than 15 minutes from any `projects/` subdirectory containing "haiku-worker".

## Key Architecture Decisions

### Process Snapshot Pattern
- `getAllProcessInfo()` returns `Map<pid, { parentPid, name }>` from a single OS call
- Stored as `processSnapshot` on StateManager
- `getProcessInfoFallback()` handles processes started after the snapshot (individual query, cached in snapshot)
- Cross-platform: Windows uses PowerShell + CIM, macOS/Linux uses `ps`

### Transcript Read Optimization
- `readFileTail()` reads only last 2MB of transcript files (not the entire file)
- `readTranscriptState()` has a cache with mtime+size check to avoid re-reads
- Subagent files skip read entirely if mtime > 10 minutes

## Performance-Critical Code Paths

| File | Function | What it does | Risk if slow |
|------|----------|-------------|-------------|
| `stateManager.ts` | `getAllProcessInfo()` | One OS call for process tree | Blocks constructor |
| `stateManager.ts` | `isSpawnedByOverlord()` | Walks 2 hops in snapshot | Called per session |
| `stateManager.ts` | `detectIdeFromProcessChain()` | Walks 6 hops in snapshot | Called per session |
| `transcriptReader.ts` | `readSubagents()` | Reads subagent transcripts | Skips old files |
| `transcriptReader.ts` | `readTranscriptState()` | Reads transcript tail | Cached by mtime |
| `claudeQuery.ts` | `cleanupOldWorkerTranscripts()` | Deletes old haiku files | Runs once at startup |

## How to Profile Startup

Add temporary timing to `index.ts`:

```typescript
const _t0 = Date.now();
const _trace = (label: string) => console.log(`[startup:trace] +${Date.now() - _t0}ms: ${label}`);
```

Then add `_trace('label')` before/after each phase. Key phases to time:
- `new StateManager()` — includes process snapshot + loadKnownSessions
- `sessionWatcher.start()` — reads session files, calls addOrUpdate for each
- `cleanupOldWorkerTranscripts()` — file system cleanup
- `loadClosedSessionsFromTranscripts()` — reads closed session transcripts
- `httpServer.listen()` — should be instant

## /clear Detection Architecture

Three mechanisms detect `/clear` (session replacement). **None use CWD matching** — CWD is unreliable because multiple sessions share the same CWD.

1. **Session file watcher** (`sessionEventHandlers.ts` `changed` event) — fires when `~/.claude/sessions/{pid}.json` updates in-place with a new `sessionId` (same PID). Fastest path — near-instant detection.

2. **Periodic stale transcript check** (3s interval in `transcriptWatcher.ts`) — for sessions in `working`/`thinking` state where `lastActivity` hasn't changed for 3 consecutive polls (9+ seconds), reads the session file to check if `sessionId` changed. **Not heavy:** only fires once per stale period (resets counter after triggering), and the session file is a tiny JSON (~100 bytes). Active and idle sessions never trigger this.

3. **Startup orphan scan** (3s delay after boot in `transcriptWatcher.ts`) — for sessions >1h stale with alive PIDs, scans transcript directory for orphan `.jsonl` files. Uses **content-based matching** (reads first 4KB of orphan, checks if it references a known stale sessionId). Only runs once at startup.

### Permission Detection (False Positives)

Long-running tools (`Bash`, `Agent`, `WebFetch`, `WebSearch`, `execute_command`, `RunCommand`) must NOT trigger the permission prompt UI. The transcript heuristic treats `tool_use` entries >8s old as permission prompts — but these tools legitimately run for minutes. They are treated like MCP tools: show `working`/`thinking`, never `needsPermission`. See `LONG_RUNNING_TOOLS` set in `transcriptReader.ts`.

## Rules

- **NEVER spawn individual PowerShell/shell calls per PID** during startup. Always use the batch snapshot.
- **NEVER read subagent transcripts without checking mtime first.** The 10-minute threshold is the same as the display filter.
- **NEVER skip haiku worker cleanup.** Without it, thousands of files accumulate within days.
- **NEVER use CWD-based matching** to link sessions or detect /clear. Always use PID, sessionId, or name markers.
- Cross-platform: every OS-level optimization must work on both Windows and macOS.
