## Spec: Auto-complete task on "DONE"

**Goal:** When the user sends exactly "DONE", the current in-progress task is automatically marked as completed.

**Inputs / Triggers:** User message that is exactly `DONE` (case-insensitive).

**Outputs / Side effects:**
- Claude detects the trigger before doing anything else
- Finds the most recent task with status `in_progress` via `TaskList`
- Marks it `completed` via `TaskUpdate`
- Confirms to the user which task was closed

**Acceptance Criteria:**
- [x] Sending `DONE` (or `done`) triggers the behavior without any other action required
- [x] The most recent `in_progress` task is marked `completed`
- [x] If no in-progress task exists, Claude responds gracefully (e.g. "No active task found")
- [x] Rule is documented in `CLAUDE.md` so it persists across sessions

**Out of scope:**
- Completing multiple tasks at once
- Specifying a task by name in the same message
- Any external task system integration

**Open questions:** None
