## Spec: Combined Task List

**Goal:** Provide a global, cross-session task feed panel that shows completed, in-progress, and waiting tasks from all active Claude Code agent sessions in one unified view.

**Inputs / Triggers:**
- User clicks a "Tasks" button in the Office header/toolbar to open the panel
- Panel subscribes to the same `OfficeSnapshot` WebSocket feed already used by the Office view
- Panel updates in real-time as sessions change state or new `completionSummaries` arrive

**Outputs / Side effects:**
- A slide-in side panel (from the left or as an overlay) renders the combined task list
- Clicking a task entry selects the corresponding session and opens its `DetailPanel`
- No server-side changes required — all data is already present in `OfficeSnapshot`

**Acceptance Criteria:**

Panel accessibility:
- [ ] A "Tasks" icon button appears in the Office header toolbar
- [ ] Clicking the button toggles the combined task list panel open/closed
- [ ] The panel can be closed via the button again or via an Escape key press
- [ ] The panel does not obscure the main Office grid; it either slides in as a left sidebar or appears as a fixed overlay with the Office remaining visible behind it

Task entries — completed tasks:
- [ ] Each entry in `session.completionSummaries` is rendered as a completed task row
- [ ] Completed rows show: a green checkmark icon, the summary text, the session's cwd (shortened), and `completedAt` timestamp formatted as relative time (e.g. "3m ago")
- [ ] Completed rows are visually muted relative to active tasks

Task entries — in-progress tasks:
- [ ] Sessions with state `working` or `thinking` are shown as active task rows using `session.lastMessage` as the task description (truncated to ~120 chars if needed)
- [ ] Working rows show a green animated status dot and label "Working"
- [ ] Thinking rows show a purple animated status dot and label "Thinking"

Task entries — waiting tasks:
- [ ] Sessions with state `waiting` are shown as waiting task rows
- [ ] Waiting rows show an amber status dot and label "Waiting for input"
- [ ] If `session.completionHint === 'done'`, the row label is "Done — awaiting review" instead

Task entries — idle sessions:
- [ ] Idle sessions are omitted from the task list entirely (they have no actionable task)

Grouping and ordering:
- [ ] Tasks are displayed in a flat timeline sorted by recency: in-progress/waiting sessions first (ordered by most recently active), then completed tasks (ordered by `completedAt` descending)
- [ ] Each task row shows the originating session's room label (cwd basename) and, if it is a subagent, a "subagent" badge
- [ ] A section divider visually separates "Active" tasks (working/thinking/waiting) from "Completed" tasks

Interactivity:
- [ ] Clicking any task row closes the task list panel and selects that session, opening its `DetailPanel` on the right
- [ ] Hovering a row highlights it with a subtle background change

Empty state:
- [ ] If there are no sessions (or all are idle), the panel shows a centered empty-state message: "No active sessions"

Visual style:
- [ ] Panel matches the existing dark theme; uses the gold `#d4af37` accent for the toolbar button active state and section dividers
- [ ] State colors follow project conventions: working=green, thinking=purple, waiting=amber
- [ ] Typography uses Inter (same as the rest of the UI); task summaries in regular weight, metadata (cwd, timestamp) in smaller muted text
- [ ] Panel width is fixed at 380px on desktop; on narrow viewports it spans full width

**Out of scope:**
- Filtering or searching the task list
- Editing or dismissing individual task entries
- Persisting the panel open/closed state across page reloads
- Fetching additional task data beyond what is already in `OfficeSnapshot`
- Any server-side API changes
- Mobile/responsive breakpoints beyond the narrow-viewport fallback noted above

**Open questions:**
- Should subagent tasks be shown inline with parent session tasks, or listed separately under the parent row? (Inline under parent is likely cleaner.)
- Should the panel be left-side or a centered overlay? Left sidebar keeps the Office grid fully visible and mirrors common dashboard patterns — preferred unless layout conflicts arise.
- Is 380px the right panel width, or should it be wider to accommodate long summaries without excessive truncation?
