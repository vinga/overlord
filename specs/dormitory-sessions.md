## Spec: Dormitory Sessions

**Goal:** Provide a client-side visual archiving mechanism that removes idle or manually dismissed sessions from the main office view without deleting them, keeping them accessible in a collapsed dormitory section per room.

**Inputs / Triggers:**

- User clicks "Send to Dormitory" action on a worker (manual dormitory)
- Session state transitions to `idle` and has been idle for longer than the auto-dormitory threshold (auto-dormitory)
- User clicks the dormitory section toggle in a room to expand/collapse it
- User clicks "Wake Up" / "Remove from Dormitory" action on a dormitory worker (manual un-dormitory)
- A dormitory session receives new activity (its state changes away from `idle`) — auto-un-dormitory

**Outputs / Side effects:**

- Session is moved from the main worker grid into the dormitory section of its room (purely client-side; no server state is modified)
- Dormitory membership is persisted to `localStorage` under a stable key (e.g. `overlord.dormitory`) as a JSON array of session IDs
- Dormitory section collapsed/expanded state is persisted to `localStorage` per room (e.g. `overlord.dormitory.collapsed.<roomId>`)
- When a dormitory session becomes active again, it is automatically removed from the dormitory set and reappears in the main worker grid

**Acceptance Criteria:**

- [ ] A session can be manually sent to dormitory via a user action (button, context menu, or similar control) on the worker
- [ ] A session is automatically sent to dormitory when it has been in `idle` state continuously for at least 5 minutes (configurable threshold)
- [ ] Dormitory membership is stored in `localStorage` and survives page reload
- [ ] Each room shows a "Dormitory" section below its main worker grid, collapsed by default
- [ ] The dormitory section header shows the count of dormitory sessions in that room (e.g. "Dormitory (3)")
- [ ] Clicking the dormitory section header toggles the section expanded/collapsed
- [ ] The collapsed/expanded state of each room's dormitory section is persisted in `localStorage`
- [ ] Dormitory workers are rendered visually distinct from active workers (smaller scale, greyed-out / reduced opacity) to reinforce their archived status
- [ ] A dormitory worker can be clicked to open the detail panel, showing its last known state
- [ ] A dormitory session can be manually returned to the main office view via a "Wake Up" action on the dormitory worker
- [ ] When a dormitory session's state changes from `idle` to any active state (`working`, `thinking`, or `waiting`), it is automatically removed from the dormitory set and reappears in the main worker grid regardless of collapsed state
- [ ] Dormitory is scoped per room — sessions only appear in the dormitory section of the room they belong to
- [ ] If a session that is in dormitory is removed from the server (WebSocket snapshot no longer includes it), it is silently removed from the dormitory set in `localStorage` as well (no stale ghost entries)
- [ ] Dormitory does not affect server state — no API calls are made when dormitory membership changes
- [ ] Sending a session to dormitory does not close an already-open detail panel for that session

**Out of scope:**

- Server-side archiving or deletion of sessions
- Cross-device or cross-browser sync of dormitory state (localStorage is local only)
- Bulk "send all idle to dormitory" action (may be a future enhancement)
- Dormitory sessions appearing in a global/cross-room dormitory view
- Notification or badge when a dormitory session wakes up automatically
- Configuring the auto-dormitory threshold via the UI (threshold is a code-level constant for now)

**Open questions:**

- Should the auto-dormitory threshold (currently assumed 5 minutes) be a named constant in shared config, or hardcoded per component?
- Should sessions that are auto-sent to dormitory be visually distinguished from manually-sent sessions (e.g. a different icon or label)?
- If a room has no active workers but has dormitory sessions, should the room itself remain visible or be hidden? (Current assumption: room stays visible with only the dormitory section showing.)
- Should there be an undo/toast notification when a session is auto-sent to dormitory, allowing the user to cancel within a short window?
- What is the exact collapsed state behavior when a dormitory session auto-wakes: should the dormitory section remain collapsed even if it had been expanded, or should the wake event have no effect on section collapse state?
