## Spec: Disable task recognition and completion summaries

**Goal:** Remove automatic task creation, LLM-based task titles, and LLM-based completion summaries. Keep the lightweight `completionHint` heuristic so waiting sessions can still show a "done" badge.

**Placement:** Server — `aiClassifier.ts`, `transcriptWatcher.ts`, `apiRoutes.ts`. No client changes required (Tasks tab will simply render empty sections).

---

### Inputs / Triggers

- Session transitions to `working` → no longer creates a task.
- Session transitions to `waiting` with a last message → heuristic still runs to set `completionHint`, but does NOT create/complete tasks or schedule summaries.
- User clicks "Mark done" → still marks session done via `markDoneByUser`, but does not fire `generateCompletionSummary`.
- Startup backfill for active/waiting sessions → does not create tasks or schedule titles.

### Outputs / Side effects

- No new `Task` objects are created, persisted, or broadcast.
- No LLM calls from `generateTaskTitle` or `generateCompletionSummary`.
- `completionHint` on sessions continues to update via `classifyByHeuristic` (no LLM).
- Existing persisted tasks on disk are left untouched (historical data). The Tasks tab may still show old tasks until they age out naturally; new activity produces none.

---

### Server

**`packages/server/src/session/transcriptWatcher.ts`**
- Remove the `becameWorking` task-creation block (currently lines 292-299: `createTaskForSession` + `generateTaskTitle`).
- Remove the backfill task-creation block (currently lines 309-317).
- Remove the backfill title-generation block (currently lines 318-323).
- Remove the `titleAttempted` set and its prune logic (no longer referenced).
- Keep the `becameWaiting → classifyCompletion` call (heuristic sets `completionHint`).

**`packages/server/src/ai/aiClassifier.ts`**
- In `classifyCompletion`: keep heuristic + `setCompletionHint` call. Remove the `completeActiveTask` + `setTimeout(generateCompletionSummary)` lines in the `heuristic === 'done'` branch.
- Delete `generateTaskTitle` method.
- Delete `generateCompletionSummary` method.
- Remove `activeTaskTitleGenerations` field if no longer used.
- Remove helper imports that become unused (`readFirstUserMessage`, `findTranscriptPathAnywhere` if only used by deleted methods).

**`packages/server/src/api/apiRoutes.ts`**
- Remove the `generateCompletionSummary` parameter from the route registration function signature and from the `mark-done` handler (line 300).

**`packages/server/src/index.ts`**
- Remove the `aiClassifier.generateCompletionSummary.bind(aiClassifier)` argument at line 961.

**`packages/server/src/session/stateManager.ts`**
- `completeActiveTask`, `createTaskForSession`, `setTaskTitle`, `setTaskSummary` remain as methods but will no longer be invoked from automatic paths. Do not delete — they are still used by plan-task path, manual `mark-done` via `acceptTask`, and inline-edit UI.

### Client

_N/A_ — the Tasks tab keeps working, it just won't receive new entries from automatic recognition.

---

### Acceptance Criteria

**Server**
- [ ] After server restart, entering `working` state does NOT create a task (verify via `session.currentTask` stays undefined on any new session).
- [ ] After server restart, entering `waiting` state still updates `session.completionHint` via heuristic (verify `[classify] … → done (heuristic)` log still fires).
- [ ] No `[task-title]` log lines appear during normal operation.
- [ ] No `[summary]` log lines appear during normal operation.
- [ ] Clicking "Mark done" on a waiting session succeeds (200 OK) and does NOT trigger `generateCompletionSummary`.
- [ ] Server builds and starts with no TypeScript errors.

**Client**
- [ ] Tasks tab renders without JS errors when there are no new tasks.
- [ ] "Awaiting" filter still shows waiting sessions (driven by session state, not task entries).

---

### Out of scope

- Cleanup of historical tasks already persisted on disk.
- Removing the Tasks tab from the UI.
- Removing plan-task creation (plans still create tasks via a different path).
- Removing the intent summarizer (`intentSummarizer.maybeRefreshIntent`) — separate system.

### Open questions

1. Should historical tasks be hidden from the Tasks tab too? Suggest: leave them visible — they're real data from earlier runs and the user may still want to review.
2. Should plan-tasks continue to appear in Tasks tab? Suggest: yes — plan tasks are user-driven, not auto-recognized, so they remain useful.
