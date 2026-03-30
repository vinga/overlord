## Spec: User Acceptance of Done Tasks

**Goal:** Let users review and explicitly accept individual completed task summaries and the current done session state, creating a clear two-step lifecycle: *Claude done* → *User accepted*.

---

### Two acceptance levels

| Level | What it covers | Trigger |
|---|---|---|
| **Session-level** | Current done state (completionHint = 'done', not yet reviewed) | "Accept" button in DetailPanel state bar |
| **Per-task** | Individual historical completion summaries | Accept button on each task row in Tasks tab and TaskListPanel |

---

### Visual states

| State | Color | Label |
|---|---|---|
| Done, not accepted | Amber `#f59e0b` | `done · review` |
| Done, accepted | Green `#22c55e` | `done ✓` |

---

### Data model

`TaskSummary` gains an `accepted` field:
```ts
interface TaskSummary {
  summary: string;
  completedAt: string; // ISO — used as stable ID for accept operations
  accepted?: boolean;
}
```

Session gains `userAccepted?: boolean` (session-level, persisted separately in `~/.claude/overlord-accepted.json`).

---

### Endpoints

- `POST /api/sessions/:id/accept` — session-level acceptance (existing, marks `userAccepted = true`)
- `POST /api/sessions/:id/accept-task` with `{ completedAt: string }` — per-task acceptance (marks matching summary as `accepted: true`, persists to task JSON file, re-broadcasts snapshot)

---

### Acceptance Criteria

**Session-level (DetailPanel state bar)**
- [ ] When `completionHint === 'done'` and `!userAccepted`, an "Accept" button is shown in the state bar
- [ ] Clicking it calls `POST /api/sessions/:id/accept`; button changes to "Accepted ✓" in green
- [ ] Session-level `userAccepted` persists across server restarts via `~/.claude/overlord-accepted.json`
- [ ] When session leaves waiting state, `userAccepted` is cleared

**Per-task (Tasks tab and TaskListPanel)**
- [ ] Each task row shows an Accept button (visible on hover) when `!summary.accepted`
- [ ] Clicking it calls `POST /api/sessions/:id/accept-task` with `{ completedAt }`
- [ ] The row immediately updates to green `✓` (no reload needed — snapshot re-broadcast)
- [ ] Accepted tasks show green `✓`; unaccepted show amber `✓` + `· review`
- [ ] `accepted` flag is persisted in the task summary JSON file alongside `summary` and `completedAt`
- [ ] Per-task accepted state survives server restarts

**Both levels — DetailPanel Tasks tab**
- [ ] Task rows show amber `✓` + `· review` when not accepted
- [ ] Task rows show green `✓` when accepted
- [ ] Accept button on each row (appears on hover)

**Both levels — TaskListPanel (room panel Done section)**
- [ ] Same amber/green distinction and per-row Accept button as DetailPanel

---

### Out of scope
- Bulk "Accept all" button
- Unaccepting / reverting accepted tasks
- Per-subagent task acceptance
