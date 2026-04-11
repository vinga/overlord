## Spec: Task Lifecycle

**Goal:** Provide a coherent per-session task model where each user request spawns a named Task with a Haiku-generated title, tracks activity through to completion, and surfaces consistently in the Worker card, Detail Panel, and Task List.

---

### Core concept

A **Task** represents one unit of work: the period from a user's first message in a "slot" to the next time the session becomes idle waiting for new input (done or awaiting). Tasks are the atomic unit of the task monitoring system.

**A new Task is created when:**
1. The session receives its very first user message (conversation start)
2. A user message arrives after `/clear` (session continuation with a new transcript)
3. A user message arrives after the previous task was marked **done** (user starts a follow-up request)

This means a long-running session accumulates a series of Tasks over time.

---

### Task data model

```
Task {
  taskId:       string        // e.g. "{sessionId}-{index}" — stable across restarts
  sessionId:    string
  title:        string        // 5–8 word Haiku summary of the first user message
  summary?:     string        // 1-sentence completion summary (generated when done)
  state:        'active' | 'done'
  createdAt:    string        // ISO — timestamp of the triggering user message
  completedAt?: string        // ISO — timestamp when state → done
}
```

**Storage:** `~/.claude/overlord/tasks/{sessionId}.tasks.json` — JSON array of Task objects, newest first. Replaces the current `{sessionId}.json` (completion summaries) and `{sessionId}.request` (request summary) files, which become part of the unified model.

---

### Task title generation

- Triggered on the same events that create a new Task (first message, post-clear, post-done)
- Haiku reads the **first 4 substantive user messages** (≥ 8 chars, skipping system/environment blocks) from the start of the relevant transcript segment
- Prompt asks for a 5–8 word specific, concrete summary of what the user wants
- Generated title is stored on the Task immediately and broadcast via snapshot
- User can **force regeneration** via a button in the Detail Panel; this overwrites title in storage and in-memory

**What counts as "first user message":**
- After conversation start: very first non-system user entry in the transcript
- After `/clear`: very first user entry in the new transcript (post-clear)
- After done: the user message that arrives while `completionHint === 'done'` and session was waiting

---

### Task completion

- Reuses the existing `classifyCompletion` + `generateCompletionSummary` pipeline (heuristic → Haiku)
- When classified as `done`: the **active** Task's `state` is set to `'done'`, `completedAt` is recorded, and a `summary` is generated from the last 10 assistant messages
- A new Task is created (with a new title) on the **next** user message after this point
- The `completionHint` field on Session remains as today (drives the Worker "done" bubble and "review" badge)

---

### Session-level fields (on `Session`)

Replace `requestSummary?: string` and `completionSummaries` with:
```
currentTask?:         Task   // the active (most recent) Task, if any
completionSummaries:  Task[] // all done Tasks for this session (kept for Task List display)
```

The existing `completionHint` and `completionHintByUser` fields are unchanged.

---

### Acceptance Criteria

**Task creation**
- [ ] When the first user message arrives in a new session (or after `/clear`), a Task is created with `state: 'active'` and `createdAt` set to the message timestamp
- [ ] When a user message arrives while `completionHint === 'done'`, the existing done Task is finalized and a new active Task is created
- [ ] Haiku title generation is queued immediately on Task creation; while pending the title is `undefined` and the Worker card shows nothing below the name
- [ ] Once the title is generated it is stored and broadcast; the Worker card updates without a page reload
- [ ] If title generation fails, the Task remains without a title (no fallback text, no error shown)

**Task completion**
- [ ] The existing `classifyCompletion` flow (heuristic + Haiku) sets the active Task's `state: 'done'` and `completedAt`
- [ ] `generateCompletionSummary` populates `task.summary`; both `summary` and `state` are updated atomically in storage
- [ ] The done Task moves to `completionSummaries`; `currentTask` becomes `undefined` until the next user message
- [ ] "Set to Done" manual override creates a done Task using the current `lastMessage` context (same as today)

**Worker card display**
- [ ] `currentTask.title` is shown below the session name in a small italic muted style when present and when `currentTaskLabel` (the active 3-4 word "doing" label) is not shown
- [ ] When `completionHint === 'done'`, the most recent done Task's `summary` is shown instead (replaces today's `completionSummary` display)
- [ ] Neither title nor summary is shown for subagent workers

**Detail Panel — Task card**
- [ ] A "Current Task" card is shown in the Detail Panel header area (below session name) when `currentTask` exists
- [ ] The card shows: title (full, not truncated), state badge (`active` / `done`), `createdAt` relative time, and a ↺ **Regenerate** icon button
- [ ] Clicking Regenerate calls `POST /api/sessions/:id/regenerate-summary` (force=true) and shows a spinner while generating; title updates in place when done
- [ ] When the Task is done, `summary` is also shown in the card below the title, along with `completedAt`
- [ ] Past done Tasks are shown in a collapsible "Task history" section (replaces today's `completionSummaries` list in DetailPanel)

**Task List panel**
- [ ] Active Tasks (`state: 'active'`) appear in the "Active" section with the Task `title` as the row label
- [ ] Done Tasks appear in the "Completed" section with both `title` and `summary` if present
- [ ] Each row shows session room label, relative timestamp, and state indicator
- [ ] Clicking a row selects the session and opens Detail Panel (existing combined-task-list behaviour)

**Post-clear task**
- [ ] After `/clear` is detected, the previous session's tasks are archived; `currentTask` is reset to `undefined`
- [ ] The very next user message in the new transcript starts a fresh Task

**Persistence & restart**
- [ ] All tasks are persisted to `{sessionId}.tasks.json`; loaded on server startup via `loadKnownSessions`
- [ ] `resumedFrom` sessions inherit the parent's task history (prepend parent tasks to child)
- [ ] Read/write failures are silently swallowed; in-memory state is unaffected

---

### Out of scope

- User editing or deleting individual Tasks from the UI
- Subagent-level Tasks (subagents show a checkmark only)
- Multi-session task grouping (e.g. grouping related tasks across sessions by topic)
- Streaming the Haiku response
- Retry logic for failed Haiku calls
- Task priority or tagging

---

### Migration

The following existing mechanisms are **replaced** by this spec and should be removed once it is implemented:
- `requestSummary` field on Session / `.request` storage files
- `completionSummaries` as a flat array of `{ summary, completedAt }` — superseded by the Task array

The following are **preserved unchanged:**
- `completionHint` / `completionHintByUser` (drives Worker done bubble)
- `currentTaskLabel` (3-4 word active label, generated by `generateActiveLabel`)
- `classifyCompletion` / `generateCompletionSummary` pipeline (wired into Task completion)
- `appendTaskSummary` deduplication logic (reused for `task.summary`)

---

### Open questions

1. Should the Task `title` be regenerated automatically when a done Task is followed by a new user message (to reflect the new request), or only on explicit user request?
2. Should the Regenerate button in Detail Panel regenerate only the `title`, or also the `summary` if the Task is done?
3. What is the exact visual treatment for the Task card in the Detail Panel — inline below the session name, or a dedicated "Task" tab section?
4. After `/clear`, should the previous session's tasks be shown as history in the new session's Detail Panel (since they share a PID), or hidden?
