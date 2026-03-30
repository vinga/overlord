## Spec: Terminal Resume

**Goal:** Allow users to resume a waiting or idle Claude session from the Office Monitor UI, spawning a new Claude process that continues the conversation via a PTY terminal panel.

**Inputs / Triggers:**
- User clicks the "▶ Resume" button in the `DetailPanel` for a session in `waiting` or `idle` state.
- The button is rendered when `onResumeSession` prop is provided and the session is in a resumable state.

**Outputs / Side effects:**
- A new PTY session is spawned on the server running `claude --resume <originalSessionId>`.
- Claude CLI creates a brand-new session with a new `sessionId`; the new session appears in `~/.claude/sessions/` and is picked up by `SessionWatcher`.
- The new session's `resumedFrom` field is set to the original `sessionId`, linking the chain.
- The `DetailPanel` switches to terminal (PTY) mode for the new session, displaying live output.
- The original session remains visible in its room, decorated with a `→` continuation badge.
- The resumed session appears in the same room (same `cwd`) as the original.

---

### 1. Trigger Conditions

A session may be resumed when its `state` is:
- `waiting` — Claude produced a final message and is awaiting user input; the process may still be alive.
- `idle` — The session process is dead (PID not found in `tasklist`) or the session has been manually marked idle.

Sessions in `working` or `thinking` state must NOT show the resume button — resuming an active session would create conflicting processes.

---

### 2. UX Flow

1. User opens `DetailPanel` by clicking a worker in `waiting` or `idle` state.
2. The panel footer shows a "▶ Resume" button.
3. On click, `onResumeSession(sessionId, cwd)` is called from `App.tsx`.
4. `useTerminal.resumeSession(sessionId, cwd)` sends `{ type: 'terminal:resume', resumeSessionId: sessionId, cwd, cols, rows }` over WebSocket.
5. Server receives the message, calls `stateManager.trackPendingResume(cwd, resumeSessionId)`, generates a PTY session ID (`pty-<timestamp>-<random>`), and replies with `{ type: 'terminal:spawned', sessionId: ptySessionId }`.
6. `PtyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', resumeSessionId])` launches Claude in a PTY.
7. The client receives `terminal:spawned`; `ptySessionIds` is updated; `DetailPanel` detects `isPtySession(ptySessionId) === true` and renders `XtermTerminal` for the PTY session.
8. Claude CLI initialises, creates a new session file in `~/.claude/sessions/`, and `SessionWatcher` fires `added` for the new `sessionId`.
9. `stateManager.addOrUpdate()` checks `pendingResumes` (keyed by `cwd`, TTL 5 s); if a matching entry exists the new session's `resumedFrom` is set to the original `sessionId`.
10. `OfficeSnapshot` is broadcast; the client renders the new session in the same room with the chain linked.

---

### 3. Session Linking (resumedFrom chain)

- `Session.resumedFrom?: string` on the **new** session points to the `sessionId` of the session it was resumed from.
- The original session is **not mutated**; it continues to exist in state with its own `sessionId`.
- `pendingResumes` map is keyed by `cwd` (workspace directory). The entry is consumed on the first new session added in that `cwd` within 5 seconds of the resume request, then deleted.
- Multi-hop chains are supported: if session B `resumedFrom` A, and C `resumedFrom` B, the chain A → B → C is implicit and can be traversed by following `resumedFrom` links.
- Completion summaries from parent sessions are prepended to the child session's `completionSummaries` array so task history carries forward across resumes.

---

### 4. Visual Indicators

#### Continuation badge on original session (Room view)
- `Room.tsx` computes `continuationIds` — the set of all `resumedFrom` values across the room's sessions.
- Any session whose `sessionId` is in `continuationIds` gets a `→` badge overlaid on its desk tile.
- The badge indicates "this session has been continued by at least one resumed session".
- Tooltip: "Session has a continuation".

#### Sibling continuation link in DetailPanel (idle original)
- When an `idle` session is selected, `App.tsx` computes `siblingActiveSessions`: sessions in the same room with `resumedFrom === selectedSession.sessionId`, sorted newest-first.
- If siblings exist, `DetailPanel` shows "Session continued →" label and clickable buttons for each sibling (styled with the sibling's color), navigating to the sibling's panel on click.
- If no siblings exist, the label reads "Session idle".
- The "▶ Resume" button is shown below regardless, allowing another resume branch.

#### New (resumed) session in Room view
- Appears as a normal worker in the same room, same desk area.
- Has no special badge itself — the badge appears on the session it was resumed from.
- Its `resumedFrom` link is available to the panel for back-navigation (future scope).

---

### 5. Error Handling

| Error condition | Behaviour |
|---|---|
| `claude` binary not found (`where claude` fails) | `PtyManager` falls back to `%USERPROFILE%\.local\bin\claude.exe`. If that path also fails, `ptyProcess` spawn throws; `PtyManager` emits `error` event. |
| `pty.spawn` throws | Server sends `{ type: 'terminal:error', sessionId: ptySessionId, message: 'Resume failed: ...' }` to the client. |
| `node-pty` not available | `PtyManager.spawn()` emits `error` immediately: "node-pty is not available on this system". |
| Resume timeout (new session never appears) | `pendingResumes` entry expires after 5 s. The new session, if it eventually appears, will not be linked. No automatic retry. |
| Claude `--resume` flag rejects unknown sessionId | Claude CLI outputs an error in the PTY terminal; the user sees it. No special client handling. |
| WebSocket disconnected during resume | PTY session is killed by the server `ws.on('close')` handler; the new Claude process is terminated. |

Error messages from `terminal:error` are surfaced in the `DetailPanel` via `getError(sessionId)`.

---

### 6. Room Grouping Behavior

- Sessions are grouped into rooms by `cwd` (working directory) in `StateManager.getSnapshot()`.
- Because the resumed session inherits the same `cwd` as the original (passed as `msg.cwd` in the `terminal:resume` message), it always lands in the same room.
- The room is created on-demand; if the original session's room already exists, the resumed session is appended to its `sessions` array.
- Sessions within a room are sorted by `startedAt` ascending, so the resumed session appears after the original.
- `standaloneSessions` filter in `Room.tsx` suppresses sessions whose `resumedFrom` points to another session **currently present** in the same room, preventing the resumed session from showing as a separate desk when the original is still visible. Once the original is removed from state, the resumed session becomes standalone.

---

### 7. Relationship Between Original and Resumed Session Activity

| Concern | Behaviour |
|---|---|
| Transcript history | The resumed session has its **own** `.jsonl` transcript starting fresh. The original's transcript is unchanged. |
| Completion summaries | The original session's `completionSummaries` are prepended into the new session's array at creation time, giving the new session the full task history. |
| State detection | Both sessions are independently tracked by `TranscriptReader`/`refreshTranscript`. The original may stay `waiting` or become `idle`; the new session transitions through `working → thinking → waiting` normally. |
| Simultaneous activity | Both sessions can be active at the same time if the user resumes a `waiting` session before it goes idle. Both appear in the room and both workers animate independently. |
| Deletion | Deleting the original session via `session:delete` has no effect on the resumed session. The resumed session continues running and `resumedFrom` still references the deleted ID. |
| PTY session vs. externally-launched session | The PTY session ID (`pty-*`) is an internal transport handle. The real Claude `sessionId` (UUID from `~/.claude/sessions/`) is what `resumedFrom` references. These are distinct namespaces. |

---

**Out of scope:**
- Resuming subagent sessions (only top-level sessions have resume UI).
- Back-navigation from resumed session panel to original (link renders but navigation is future scope).
- Resuming sessions across different `cwd` values (the resume always uses the session's own `cwd`).
- Automatic resume on reconnect or server restart.
- Conflict resolution when two clients resume the same session simultaneously.
- Non-PTY (injected text) resume path — resume always opens a terminal panel.

**Open questions:**
- Should the "▶ Resume" button also appear for `waiting` sessions, or only `idle`? Currently the code renders it whenever the panel is open and `onResumeSession` is provided, regardless of state — the spec should lock this down to `waiting` and `idle` only.
- Should the original `waiting` session be automatically transitioned to `idle` when a resume is initiated, to avoid two active-looking workers for the same conversation thread?
- Should a resumed session that has `resumedFrom` display a back-link in the panel header pointing to the original session (e.g. "↩ Resumed from …")?
- The 5-second TTL for `pendingResumes` may be too short on slow machines where Claude takes time to write the session file. Should this be configurable or longer (e.g. 15 s)?
- If the room's `cwd` no longer exists on disk when resume is triggered, `ptyManager.spawn` will fail with a path error — should the server validate `cwd` existence before spawning?
