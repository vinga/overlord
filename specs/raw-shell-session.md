## Spec: Raw Shell Session (No LLM)

**Goal:** Add a 4th spawn option — an embedded terminal running a bare shell (no Claude, no LLM). Useful for manual exploration, running git commands, inspecting files, or any non-AI task, all inside the Overlord UI next to AI sessions.

**Inputs / Triggers:**
- `RoomSpawnDialog` exposes a new mode `raw` (after `embedded`, `bridge`, `plain`).
- Label: `Shell`. Tooltip: "Embedded terminal running a plain shell — no Claude, no monitoring. Useful for manual tasks."
- Selecting `raw` + Spawn sends a new WS message `terminal:spawn-raw` with `{ cwd, name, cols, rows }`.

**Outputs / Side effects:**
- Server spawns a PTY running the user's shell (`$SHELL` on unix, `powershell.exe` on Windows) in the requested cwd.
- A new `Session` entry is added to `StateManager` with `sessionType: 'raw'`, a synthetic `sessionId` (`raw-<ts>-<rand>`), no transcript path, no `overlordId` lineage, no activity feed.
- The session appears as a Worker in the correct room; clicking opens `DetailPanel` showing only the embedded terminal (no activity feed, no tasks, no task-related controls).
- PTY output streams via existing `terminal:output` WS messages; input via `terminal:input`.
- On PTY exit, the session is marked `closed` and eventually removed (same cleanup as embedded claude sessions).

**Acceptance Criteria:**
- [ ] `TerminalSpawnMode` type (client + server) includes `'raw'`.
- [ ] `RoomSpawnDialog` shows 4 mode rows; `Shell` row has no command preview (same as `embedded`).
- [ ] `App.handleNewFolderSpawn` routes `raw` mode to a new `terminal.spawnRawShell(cwd, name)` hook method (sends `terminal:spawn-raw`).
- [ ] `ptyManager.spawn()` accepts an optional `executable` override; raw shell sessions pass the resolved shell binary.
- [ ] Server `wsHandler.ts` handles `terminal:spawn-raw`: creates session entry, calls `ptyManager.spawn(id, cwd, cols, rows, [], shellBin)`, emits `terminal:spawned`.
- [ ] `StateManager.addOrUpdate` (or a new `addRawSession` method) creates a minimal session with `sessionType: 'raw'`, `provider` unset, `state: 'working'`, no transcript/activity feed.
- [ ] The raw session is excluded from all claude-specific watchers: no transcript reader attached, no PID-based `/clear` detection, no stale-transcript polling, no compact detection.
- [ ] `Worker` component renders raw session with a distinct visual cue (e.g., shell icon or grey color) so it's obvious at-a-glance it's not an AI session.
- [ ] `DetailPanel` for raw sessions shows only the terminal area — hides activity feed, tasks, plan status, bridge badge, classify/AI controls.
- [ ] PTY input/output/resize/kill work identically to embedded mode (reuses `terminal:input`, `terminal:output`, `terminal:resize`, `terminal:kill`).
- [ ] On PTY exit, `StateManager` marks the raw session `closed` and it disappears after the normal closed-session TTL.
- [ ] Restarting the server does not resurrect a raw session (they have no session file on disk).

**Out of scope:**
- Resume for raw shells (they are ephemeral — closing = gone).
- Injecting text into raw shells from Overlord's message composer (no chat UI for raw sessions).
- Running anything other than `$SHELL` (no per-mode command template in v1).
- Persistence of raw sessions across server restarts.
- Subagent support, task extraction, plan detection — none apply.
- Bridge pipe / named-pipe relay for raw shells.

**Open questions:**
- Should the raw session's Worker icon be distinct (e.g., `⌘_` / terminal glyph) vs reusing the claude avatar with a grey tint? Suggest: grey + terminal glyph.
- Shell resolution: `process.env.SHELL || '/bin/zsh'` (unix), `process.env.COMSPEC || 'powershell.exe'` (Windows) — OK?
- Should closing the DetailPanel kill the PTY or keep it running in the background? Suggest: keep running; kill only via explicit action or PTY exit (same as embedded).
- Do we want a hotkey to open a quick raw shell in a room without going through the spawn dialog? (Follow-up, not v1.)
