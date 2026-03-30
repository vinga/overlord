## Spec: Active Task Label

**Goal:** For actively working top-level agents, generate and display a short (3–4 word) ephemeral label describing what they are currently working on, shown below the worker avatar in the same position as the completion summary.

**Inputs / Triggers:** Session transitions into `working` or `thinking` state and remains there for a 3-second stability window without reverting.

**Outputs / Side effects:** A `currentTaskLabel?: string` field is set on the session in-memory (never persisted to disk) and broadcast via `OfficeSnapshot`. The Worker component renders it below the avatar. The label is cleared when the session leaves `working`/`thinking`.

**Acceptance Criteria:**

**Label generation**
- [ ] When `refreshTranscript()` detects a session has entered `working` or `thinking` from a different state, a 3-second debounce timer is started for that session.
- [ ] If the session is still in `working` or `thinking` after 3 seconds, `generateActiveLabel(sessionId)` is called.
- [ ] If the session leaves `working`/`thinking` before the 3 seconds elapse, the timer is cancelled and no Haiku call is made.
- [ ] `generateActiveLabel()` reads the session's activity feed: takes the most recent user message (up to 200 chars) and the most recent tool call name + input (up to 100 chars).
- [ ] The Haiku prompt is: `"A Claude Code AI agent is actively working. Describe what it is doing in 3-4 words. Be specific and action-oriented. No punctuation. No preamble.\n\nLast user message: \"{userMsg}\"\nMost recent tool: \"{toolName} {toolInput}\"\n\n3-4 word label:"`.
- [ ] The Haiku call uses a 15-second timeout.
- [ ] The result is stored via `stateManager.setCurrentTaskLabel(sessionId, label)` only if the session is still `working` or `thinking`.
- [ ] If Haiku fails or times out, `setCurrentTaskLabel` is not called and no label is shown (silent fail).
- [ ] Only top-level sessions receive active labels — subagents do not.
- [ ] Rapid state changes (working→waiting→working within 3s) do not result in a Haiku call because the timer is cancelled on state exit.

**Label clearing**
- [ ] When a session transitions out of `working`/`thinking` (to `waiting`, `idle`, or any other state), `stateManager.setCurrentTaskLabel(sessionId, undefined)` is called to clear the label.
- [ ] The cleared label is reflected in the next broadcast.

**UI rendering**
- [ ] `currentTaskLabel` is shown below the worker avatar label in the same CSS position as `completionSummary` (class `activeTaskLabel`).
- [ ] It is shown only when `state === 'working' || state === 'thinking'` and `currentTaskLabel` is non-empty.
- [ ] It is not shown for subagents (`isSubagent === true`).
- [ ] When `completionHint === 'done'` and state is `waiting`, `completionSummary` is shown instead (no overlap).
- [ ] Color: muted purple (`rgba(167, 139, 250, 0.7)`) to match the working/thinking state color.

**Out of scope:**
- Persisting `currentTaskLabel` to disk.
- Showing the label in the TaskListPanel.
- Generating labels for subagents.
- Continuous label updates (label is generated once on state entry, not refreshed while working).

**Open questions:**
- Should the label update if the session has been working for a long time (e.g., re-generate every 60s)?
- Should the label appear in the RoomDetailPanel session list?
