## Spec: Shell History Persistence

**Goal:** Preserve raw-shell (`sessionType: 'raw'`) terminal output across server restarts so users see prior scrollback when reopening a session, without re-executing anything. Clean up logs for deleted/expired sessions so they don't accumulate.

**Inputs / Triggers:**
- Every chunk of PTY output from a raw-shell session is written to a per-session log file on disk.
- Server startup scans the log directory and reconciles with known sessions.
- Client attaches to a raw-shell session (fresh or revived) and requests the terminal to be populated.

**Outputs / Side effects:**
- New directory `data/pty-logs/` (configurable via env) holds `{sessionId}.log` files.
- Every raw PTY output byte-range is appended to the session's log (tee alongside the WS broadcast).
- Each log file is size-capped (default **2 MB**); when the cap is exceeded, the file is truncated from the head, keeping only the last 2 MB of raw output.
- On client-side terminal attach, server streams the log contents as a dump message (new WS type `terminal:history-dump`) before any live output.
- A separator banner (`\r\n\x1b[2m── restored shell history above · <timestamp> ──\x1b[0m\r\n`) is emitted between the dump and the live prompt.
- Logs only exist for `sessionType: 'raw'` sessions (claude sessions already have transcripts).

**Session Revival Behavior:**
- Revival means: on startup, the server re-creates a `Session` entry for each `{sessionId}.log` that belongs to a previously-known raw session, so the worker appears in the office again.
- The revived session starts with **no live PTY** (no shell process spawned). The session is marked with a new flag `historyOnly: true`.
- Clicking the revived worker opens the terminal populated from the log; an explicit "Restart shell" action spawns a new PTY in the original `cwd`, at which point `historyOnly` is cleared and live I/O resumes.
- This guarantees zero re-execution: revival never spawns processes on its own.

**Cleanup Rules:**
- **On session deletion** (`DELETE /api/sessions/{id}` or `onDeleteSession`): delete the corresponding `{sessionId}.log` file immediately.
- **On session expiry** (closed session past its TTL in `StateManager`): delete the log when the session record is removed.
- **On server startup sweep:**
  - List files in `data/pty-logs/`.
  - For each log, check if the sessionId is:
    - Known to the session registry (session meta file exists, or in the dormitory) → keep.
    - Unknown (no metadata anywhere) and older than **30 days** → delete.
    - Unknown but newer than 30 days → keep (could be an in-flight metadata crash).
- **Total size cap across all logs:** default **500 MB**. On every append that would exceed the cap, delete the oldest log files (by mtime) until under the cap.
- Log cleanup runs:
  - Synchronously on session delete/expiry (single file).
  - On server startup (sweep).
  - Periodically every **6 hours** while running (sweep + total-size enforcement).

**Storage Format:**
- Raw bytes appended as-is (same bytes xterm receives live). Preserves ANSI colors, cursor moves, etc.
- Truncation from the head is byte-based. Escape sequences may be cut mid-sequence — accepted risk; xterm's parser recovers on the next valid sequence. Optional future enhancement: snap truncation to the last newline.
- File is opened in append mode, `O_APPEND`; writes are fire-and-forget (no await on hot path).

**Acceptance Criteria:**
- [ ] New module `packages/server/src/pty/shellHistoryLog.ts` exposes `appendOutput(sessionId, bytes)`, `readAll(sessionId): Buffer`, `deleteLog(sessionId)`, `sweep()`, `enforceTotalCap()`.
- [ ] `ptyManager.ts` calls `appendOutput` for every output chunk from raw sessions only (gated by `sessionType === 'raw'`).
- [ ] Per-file size cap enforced inside `appendOutput` (when file grows past 2 MB, rewrite keeping last 2 MB).
- [ ] New WS message `terminal:history-dump` with `{ sessionId, data: base64 }` is sent on terminal attach for raw sessions that have a non-empty log; client decodes and writes to the xterm instance before processing live output.
- [ ] Separator banner is appended to the dump payload server-side (not written to log file) so the log remains pure output.
- [ ] On server start, `StateManager` reconciles `data/pty-logs/*.log` with session metadata:
  - Logs with no matching session → re-create a minimal raw session entry with `historyOnly: true`, `state: 'closed'` (or new state `dormant`), last-seen timestamp = log mtime, cwd unknown unless persisted elsewhere.
  - Logs with matching session metadata → attach log to existing session.
- [ ] New Session field `historyOnly?: boolean`.
- [ ] `DetailPanel` for `historyOnly` sessions shows the restored scrollback and a prominent **"Restart shell"** button that spawns a new PTY in the original cwd and clears `historyOnly`.
- [ ] Deleting a session (via desk menu) removes its log file on the same path the session record is deleted.
- [ ] Expiry/TTL cleanup in `StateManager` removes the log when the session record is purged.
- [ ] Startup sweep deletes logs with no session meta and older than 30 days.
- [ ] Periodic sweep runs every 6 hours (unref'd `setInterval`) and also enforces total-size cap.
- [ ] Total-size cap (default 500 MB) is enforced in `enforceTotalCap`: deletes oldest files until under cap.
- [ ] Both caps (per-file 2 MB, total 500 MB) are read from env (`OVERLORD_SHELL_LOG_PER_FILE_MB`, `OVERLORD_SHELL_LOG_TOTAL_MB`) with defaults.
- [ ] CWD for each raw session is persisted (e.g., alongside the log as `{sessionId}.meta.json`) so revival knows where to re-spawn if the user clicks "Restart shell".
- [ ] Meta file is deleted together with the log file in all cleanup paths.

**Out of scope:**
- Persisting live process state (running jobs, env vars, cwd changes after spawn) — only output history is preserved.
- Applying this to bridge / embedded / ide sessions (they already have transcripts).
- Replaying command history into shell's `.bash_history` / `.zsh_history` — shell already handles that.
- Incremental replay UI (e.g., scrub through time) — v1 dumps everything and lets xterm render it.
- Cross-machine log sync.
- Compression of log files (v1 plain raw bytes).

**Open questions:**
- Should revival show the worker as a distinct state (`dormant`) in the office, or reuse `closed`? Suggest new state `dormant` to make "restartable" clear.
- What happens if the user renames a revived session — should the rename persist before they restart the shell? Suggest: yes, rename writes to the meta file.
- Do we want a manual "Clear history" action on the detail panel? Suggest: yes, simple button that deletes the log file and empties the xterm buffer.
- Should logs be stored per-room (nested dirs) or flat? Suggest: flat, keyed by sessionId — cleanup logic is simpler.
