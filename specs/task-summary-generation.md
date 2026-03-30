## Spec: Automatic Task Summary Generation

**Goal:** Automatically detect when a Claude Code session has completed a task, classify the outcome, and generate a concise one-line summary that persists across sessions and is surfaced in the UI.

**Inputs / Triggers:**
- Periodic state refresh (every 3 seconds) calls `stateManager.refreshTranscript()` for every known session; if the session transitions from a non-waiting state into `waiting`, the last assistant message is passed to `classifyCompletion()`.
- When a new session is discovered via `SessionWatcher` already in the `waiting` state, the same `classifyCompletion()` flow is triggered on `added`.
- A manual HTTP trigger via `POST /api/summarize` with `{ sessionId }` in the body.

**Outputs / Side effects:**
1. **Completion hint** (`'done'` or `'awaiting'`) is stored in-memory on the `Session` object (`completionHint` field) and persisted to `~/.claude/overlord/tasks/{sessionId}.hint`.
2. **Task summary** — a single short sentence (≤ 10 words) — is appended to `~/.claude/overlord/tasks/{sessionId}.json` (an array of `{ summary, completedAt }` entries) and reflected on the `Session` object as `completionSummaries`.
3. A WebSocket `OfficeSnapshot` broadcast is sent to all clients after each state change.
4. The `Worker` component in the office view renders a green `done` bubble and displays the most recent summary text beneath the worker avatar.
5. The `DetailPanel` component renders the state badge as green "done" and shows the full task summary history.

---

**Acceptance Criteria:**

**Trigger & keyword detection**
- [ ] When `refreshTranscript()` detects a state transition to `waiting` (previous state was not `waiting`), `classifyCompletion(sessionId, lastMessage)` is called with the assistant's last message text.
- [ ] When `SessionWatcher` fires `added` and the session is already in `waiting` state, `classifyCompletion()` is called.
- [ ] `classifyCompletion()` is not called if the state did not transition to `waiting` (e.g. already waiting on previous poll, or transitioning to working/idle/thinking).

**Heuristic pre-classification (runs synchronously, no Haiku call)**
- [ ] A message matching `/^done[.!\s]*$/i` (bare "done" variants) is immediately classified as `'done'`.
- [ ] Messages shorter than 40 characters (excluding the bare-done case) are immediately classified as `'awaiting'`.
- [ ] Messages ending with `?` are immediately classified as `'awaiting'`.
- [ ] Messages containing common question/clarification phrases (e.g. "would you like", "should i", "let me know if") are immediately classified as `'awaiting'`.
- [ ] Messages containing obvious completion signals (e.g. "i've completed", "successfully ", "all done", "has been created") are immediately classified as `'done'`.
- [ ] If the heuristic returns `null` (inconclusive), the Haiku API call is made.

**Haiku classification (async, called only when heuristic is inconclusive)**
- [ ] The classification prompt sent to Haiku is: "A Claude Code AI agent sent this message to a user. Did it complete a task/request (and is done), or is it asking a question / waiting for more user instructions?\n\nMessage: \"{lastMessage (≤300 chars)}\"\n\nReply with exactly one word: done OR awaiting"
- [ ] The Haiku call uses a 45-second timeout via `runClaudeQuery()`.
- [ ] The raw Haiku response is parsed: if it contains the substring `'done'` (case-insensitive), the hint is `'done'`; otherwise `'awaiting'`.
- [ ] If the Haiku call times out or throws, a warning is logged and no hint is set for this classification cycle; the session is not left in an error state.

**Completion hint state management**
- [ ] `stateManager.setCompletionHint()` only applies the hint if the session is still in `waiting` state AND `session.lastMessage` still equals the message that triggered the classification (guards against the session moving on during the async Haiku call).
- [ ] When `completionHint` is `'done'`, it is persisted to `~/.claude/overlord/tasks/{sessionId}.hint`.
- [ ] `completionHint` is cleared (in-memory and on disk) when the session leaves the `waiting` state (i.e. transitions to `working`, `thinking`, or `idle`), representing a new working phase.
- [ ] On server startup / first session encounter, a persisted hint is loaded from disk via `loadCompletionHint()` and restored to `completionHint` on the session.

**Summary generation (only when hint is `'done'`)**
- [ ] After classifying as `'done'`, summary generation is scheduled with a 2-second delay (`setTimeout(..., 2_000)`). The delay exists to confirm the `waiting` state is stable and the session has not immediately resumed work before we commit the summary.
- [ ] `generateCompletionSummary()` reads the session's transcript, collects the last 10 assistant messages (each truncated to 300 characters), and joins them with `\n\n---\n\n`.
- [ ] The summary prompt sent to Haiku is: "Based on these recent messages from a Claude Code agent session, write a single short sentence (max 10 words) summarizing what was accomplished. Be specific and concrete. No preamble.\n\nMessages:\n{context}\n\nOne-line summary:"
- [ ] The Haiku call uses a 45-second timeout.
- [ ] Before storing the summary, the function verifies that the session is still in `waiting` state AND `session.lastMessage` still equals the original triggering message. If the session has moved on, the summary is silently discarded.
- [ ] The summary is stripped of surrounding quote characters before storage.
- [ ] The summary is appended via `appendTaskSummary(sessionId, summary)`, which stores `{ summary, completedAt: ISO }` in `~/.claude/overlord/tasks/{sessionId}.json`.

**De-duplication and summary merging**
- [ ] Before storing a new summary, `appendTaskSummary()` passes the new summary and the full existing summary history to a comparison step that decides one of three outcomes:
  - **Skip** — the new summary conveys the same meaning as an existing entry (exact or near-duplicate); nothing is written.
  - **Update previous** — the new summary supersedes or extends the most recent entry (e.g. same task, more detail); the existing entry is replaced in-place rather than appended.
  - **Append** — the new summary describes a distinct task; it is added as a new entry.
- [ ] The comparison uses Haiku with a prompt that provides the new summary and the last 3 existing summaries, asking it to choose: `skip`, `update_previous`, or `append`, and (if `update_previous`) what the merged text should be.
- [ ] If the Haiku comparison call fails or times out, the fallback is a simple case-insensitive exact-match check against the last entry only: skip if identical, append otherwise.
- [ ] The comparison is only run when at least one prior summary exists; if the history is empty, the new summary is always appended directly.

**Storage**
- [ ] Task summaries are stored as a JSON array at `~/.claude/overlord/tasks/{sessionId}.json`; the directory is created recursively if it does not exist.
- [ ] The `.hint` file is stored at `~/.claude/overlord/tasks/{sessionId}.hint` alongside the JSON file.
- [ ] Read and write failures (e.g. permissions) are caught and silently ignored; the in-memory state remains unaffected.

**Summary history across resumed sessions**
- [ ] When a session is created that has a `resumedFrom` link (i.e. it was started via `--resume`), the persisted summaries of the parent session are prepended to the child's own summaries, so history carries forward.
- [ ] The merged list is only assembled once on first encounter (`isNew === true`); subsequent transcript refreshes preserve the in-memory `completionSummaries` without re-reading disk.

**Manual summarize endpoint**
- [ ] `POST /api/summarize` accepts `{ sessionId: string }` in the JSON body.
- [ ] The endpoint reads the transcript at the path found by `findTranscriptPathAnywhere(sessionId)`. If no transcript is found, it responds `{ summary: 'No transcript found for this session.' }`.
- [ ] It extracts up to 20 recent user and assistant messages (scanning from the end of the transcript), each truncated to 600 characters.
- [ ] If fewer than 2 messages are found, it responds `{ summary: 'Not enough conversation to summarize.' }`.
- [ ] The Haiku prompt asks for 3-5 bullet points summarizing high-level goals and accomplishments (using `•` prefix), with a 60-second timeout.
- [ ] The response is `{ summary: string }` (or `{ error: string }` on failure).
- [ ] This endpoint produces a multi-bullet format distinct from the automatic one-line completion summary; it is not stored in `taskStorage` and does not affect `completionHint`.

**UI — Worker bubble and inline summary**
- [ ] When `state === 'waiting'` and `completionHint === 'done'`, the `Worker` component renders a green `done` bubble (class `bubbleDone`) instead of the default amber `waiting` bubble.
- [ ] When `state === 'waiting'` and `completionHint === undefined` (classification still in progress), a small spinner (class `classifyingSpinner`) is shown next to the `waiting` bubble, indicating the system is checking.
- [ ] When `completionHint === 'done'` and `completionSummaries` has at least one entry, the most recent summary text is rendered beneath the worker avatar label as `styles.completionSummary`.
- [ ] The inline summary is only shown for main sessions (not subagents).

**UI — DetailPanel state badge and history**
- [ ] `StateBadge` renders in green with label `'done'` when `state === 'waiting' && completionHint === 'done'`; otherwise it follows normal state colors.
- [ ] The activity section of `DetailPanel` shows "Task complete" as the status label when `isDone` is true, "Waiting for approval" when `needsPermission` is true, or the state name otherwise.

**Edge cases**
- [ ] If the transcript file cannot be read during summary generation, `generateCompletionSummary()` logs a warning and returns without storing anything.
- [ ] If the transcript contains no assistant messages with non-empty text blocks, `generateCompletionSummary()` exits early without calling Haiku.
- [ ] If both the heuristic and Haiku agree a message is `'awaiting'`, no hint is persisted to disk and no summary is generated.
- [ ] Rapid successive transcript changes (e.g. working → waiting → working within 2 seconds) result in the scheduled summary generation being silently discarded due to the `lastMessage` guard check.
- [ ] Concurrent classification calls for the same session (e.g. triggered by both `added` and the periodic poll) are each independently validated against current session state before applying changes; the last valid write wins.

**Manual "Set to Done" override**
- [ ] A "Set to Done" button is shown in the `DetailPanel` state bar whenever `completionHint !== 'done'` and state is not `idle`.
- [ ] Clicking it sends `POST /api/sessions/{sessionId}/mark-done` to the server.
- [ ] The server sets `completionHint = 'done'` and `completionHintByUser = true` on the session regardless of current state, persists the hint to disk, and broadcasts the updated snapshot.
- [ ] `completionHintByUser = true` prevents the automatic classifier from overriding the user's choice (the `setCompletionHint()` guard `!session.completionHintByUser` already implements this).
- [ ] The Worker indicator immediately updates to show the green `done` bubble.
- [ ] When the CLAUDE.md `DONE` shortcut is triggered (user types "DONE"), after marking the in-progress task complete, Claude also calls `POST /api/sessions/{sessionId}/mark-done` for the current session. The session ID is found by reading `~/.claude/sessions/*.json` and matching the entry whose `cwd` equals the current working directory.

---

**Out of scope:**
- Subagent-level task summaries (subagents show only a checkmark, not a `done` badge or summary text).
- User-editable or user-deletable summaries from the UI.
- Automatic summary generation for sessions in states other than `waiting` (manual "Set to Done" may set the hint in any non-idle state, but does not trigger summary generation).
- Streaming the Haiku response; the full response is awaited before processing.
- Any retry logic for failed Haiku calls; a single attempt is made per classification trigger.
- The `/api/summarize` multi-bullet output being stored or shown in the Worker/DetailPanel task history.

**Open questions:**
- Should the 2-second stability delay be configurable, or are there scenarios (e.g. fast task chains) where it should be longer?
- Should duplicate detection compare against all previous summaries (not just the last), to handle cases where a session repeatedly accomplishes the same kind of task?
- Should the `awaiting` hint be persisted to disk (currently only `done` is persisted), so that the "classification spinner" is not re-shown after a server restart for sessions that were already classified as awaiting?
- Is the 10-word cap on the auto-summary tight enough for the Worker inline display, or should the prompt be updated to enforce a character limit instead?
