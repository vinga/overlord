## Spec: Room Detail View

**Goal:** Clicking the room name label opens a detail panel (or overlay) that gives a rich, at-a-glance overview of the workspace — its full path, the health of all sessions inside it, aggregated metrics, and quick actions.

**Inputs / Triggers:**
- User clicks the `<span className={styles.roomName}>` element inside a room's title bar.
- The room name is currently rendered as a gold, uppercase 13px label. It becomes a clickable affordance (cursor pointer, subtle hover state).

**Outputs / Side effects:**
- A `RoomDetailPanel` slides in from the right side, overlapping the same position as the session `DetailPanel`.
- Only one panel is open at a time: opening a room detail panel closes any open session `DetailPanel`, and vice-versa.
- No server state is mutated; this is a read-only view (except for the spawn-session action, which delegates to the existing `onSpawnSession` callback).

**Acceptance Criteria:**

**Trigger & Open/Close**
- [ ] Clicking the room name label opens the `RoomDetailPanel` for that room.
- [ ] The room name has a pointer cursor and a visible hover effect (e.g. subtle gold underline or brightness increase) so it is clearly interactive.
- [ ] Clicking the room name while the panel for the same room is already open closes it (toggle).
- [ ] Pressing `Escape` closes the panel.
- [ ] The panel renders in the same right-side slide-in position and uses the same panel width and resize handle as the session `DetailPanel` — reusing `panelWidth` / `onPanelWidthChange` state from `App.tsx`.
- [ ] Opening the room panel clears `selectedSessionId` so the session `DetailPanel` is not simultaneously visible.
- [ ] Opening a session (by clicking a worker avatar) clears `selectedRoomId` so the room panel is not simultaneously visible.

**Header**
- [ ] Panel header shows the room `name` (basename) as the primary title in the same typographic style as the session `DetailPanel` header.
- [ ] Full `cwd` path is shown below the title in a monospace, muted style — truncated with `…` at the left side if it exceeds the panel width, so the trailing folder is always readable.
- [ ] A copy-to-clipboard button sits next to the `cwd` path; clicking it copies the full path and shows a brief "Copied" confirmation (same pattern as existing copy affordances in `DetailPanel`).
- [ ] A close (×) button in the top-right corner dismisses the panel.

**Session Summary Bar**
- [ ] A compact summary row beneath the header shows: total session count, count of active sessions (state ≠ `idle`), and count of idle sessions.
- [ ] State pill counts use the established state colors: working=green, thinking=purple, waiting=amber, idle=muted — each count is only rendered if > 0.
- [ ] Aggregated token usage (sum of `inputTokens` across all sessions in the room that have a non-null value) is shown as "N tokens" with appropriate K/M formatting — omitted entirely if no session has token data.

**Session List**
- [ ] All sessions belonging to the room are listed in order: active sessions first (sorted by `lastActivity` descending), then idle sessions (sorted by `lastActivity` descending).
- [ ] Each session row shows:
  - State indicator dot (color-coded per state conventions).
  - Session display name: `customName` if set, otherwise `proposedName` if set, otherwise a short truncation of `sessionId`.
  - `lastActivity` formatted as relative time (e.g. `<1m`, `5m`, `2h`) — same `lastActivityLabel` logic already in `Room.tsx`.
  - Most recent `completionSummaries` entry text (if any), truncated to ~80 chars with `…`.
  - Model badge (e.g. `sonnet`, `haiku`) if `model` is present — same style as session `DetailPanel`.
  - Subagent count badge if `subagents.length > 0` (e.g. `3 agents`).
- [ ] Clicking a session row closes the room panel and opens the session `DetailPanel` for that session (calls `onSelectSession`).
- [ ] Each session row has a hover highlight so it is clearly clickable.
- [ ] If a session has `needsPermission: true`, a "Needs permission" warning badge is shown prominently on that row.

**Quick-Launch Action**
- [ ] A "New session" button is present at the bottom of the panel (or in the header), visible only when `onSpawnSession` is provided.
- [ ] Clicking it calls `onSpawnSession(room.cwd)` — the same behavior as the existing `+` button in the room title bar.
- [ ] The button uses the established gold accent color (`#d4af37`) and matches the premium button style of the rest of the UI.

**Visual Design**
- [ ] The panel uses the same dark-theme background, spacing, and typography conventions as the existing `DetailPanel`.
- [ ] State color pills, badges, and interactive affordances follow the established UI conventions documented in memory (`ui_conventions.md`).
- [ ] The panel is not cluttered: sections are separated by subtle dividers; empty sections (e.g. no token data, no completion summaries) are omitted rather than shown as blank rows.

**Out of scope:**
- Editing or renaming the room / workspace path.
- Showing a merged activity feed across all sessions (cross-session timeline).
- Showing subagent detail inside the room panel (subagents are accessible by clicking through to the session panel).
- Any backend API changes — all data is already present in the `Room` and `Session` types delivered via the existing WebSocket snapshot.
- Persistent room-level notes or annotations.

**Open questions:**
- Should the room panel update live as the snapshot changes (sessions transition state) while it is open, or show a static snapshot from when it was opened? Live updates are preferred for consistency with the session `DetailPanel`, but this should be confirmed.
- If a room has many sessions (e.g. 10+), should the session list scroll internally or expand the panel height? Suggest: fixed-height scrollable list with a max-height, consistent with the `DetailPanel` activity feed approach.
- Should the "New session" button be duplicated (both in the header and the footer), or appear only once? Suggest: header placement only, to keep the footer clean.
