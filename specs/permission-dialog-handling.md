## Spec: Permission Dialog Detection and Approval Flow

**Goal:** Detect when a Claude Code session is blocked on a permission prompt, surface a clear UI indicator to the operator, and allow one-click approval or denial without leaving the Overlord dashboard.

---

### Inputs / Triggers

- `PermissionChecker` polling interval fires every 3 s for every non-idle session.
- `TranscriptReader` reads the transcript tail on every file-change event and may independently set `needsPermission = true` from JSONL entries.
- Operator clicks one of the three response buttons in the `DetailPanel` permission prompt UI.

---

### Outputs / Side effects

- `session.needsPermission` flag (boolean | undefined) exposed in `OfficeSnapshot` → WebSocket broadcast → client state.
- `session.permissionPromptText` string (cleaned terminal text block) shown verbatim in the detail panel.
- Worker badge ("⚠ approval") and bubble ("needs approval") rendered in the office grid.
- `PermissionPrompt` component rendered at the top of the active session's `DetailPanel`.
- On operator response: keystrokes injected into the Claude process via `POST /api/sessions/:id/inject`; flag cleared; 30 s suppression window started.

---

### Acceptance Criteria

#### Detection flow

- [ ] `PermissionChecker` calls `readScreen(pid)` every 3 s for every session whose `state` is not `idle`.
- [ ] A screen capture is classified as a permission prompt if and only if it matches `PRIMARY_PATTERN` (`/do you want to proceed/i`) **and** at least one `SECONDARY_PATTERN` (`/esc to cancel/i` or `/yes,? (?:and )?allow .* (?:during|for) this session/i`). The updated secondary pattern covers both the standard dialog format ("Yes, allow [tool] during this session") and the subagent dialog format ("Yes, and allow Claude to edit its own settings for this session").

  **Known dialog variants:**
  - Standard: `Yes, allow [tool] during this session`
  - Subagent: `Yes, and allow Claude to edit its own settings for this session`
- [ ] On positive match, `stateManager.setNeedsPermission(sessionId, true, promptText)` is called with the last ≤15 non-empty lines of the captured screen, stripped of non-printable characters and collapsed consecutive blank lines.
- [ ] `setNeedsPermission(true)` does nothing if a suppression window is active (i.e., `permissionApprovedAt` is set and `Date.now() - permissionApprovedAt < 30_000`).
- [ ] `setNeedsPermission(true)` sets `session.needsPermission = true` and stores `permissionPromptText` only when the flag is not already set; if the flag is already set but `permissionPromptText` is absent, the text is filled in without emitting a duplicate change event.
- [ ] A WebSocket `OfficeSnapshot` broadcast is triggered after any state change caused by `setNeedsPermission`.

#### False positive reduction (hysteresis)

- [ ] The screen reader's `missCount` counter increments by 1 each polling cycle where the permission pattern is not matched for a given session.
- [ ] Screen reader misses do **not** clear `needsPermission`; only the transcript reader owns clearing (when the session advances past the prompt and `result.needsPermission` becomes false).
- [ ] Stale `missCount` entries for sessions no longer tracked by `StateManager` are removed each polling cycle.
- [ ] Sessions whose state is `idle` are skipped entirely during each polling cycle.

#### UI — worker badge

- [ ] When `needsPermission === true` and the worker is not a subagent, a "⚠ approval" badge is rendered above the worker figure in the office grid.
- [ ] When `state === 'waiting'` and `needsPermission === true`, the state bubble renders "needs approval" instead of the default "waiting" bubble.
- [ ] The badge and bubble are absent when `needsPermission` is falsy.
- [ ] Subagent workers do not show the permission badge regardless of the `needsPermission` value on their parent session.

#### UI — detail panel prompt

- [ ] When the selected session has `needsPermission === true`, a `PermissionPrompt` block is rendered at the top of the `DetailPanel`, above all other content.
- [ ] If `permissionPromptText` is present it is displayed verbatim in a `<pre>` element inside the prompt block.
- [ ] Three buttons are shown: **Yes** (sends `\r`), **Yes, allow this session** (sends `\x1b[B\r`, i.e. arrow-down then Enter), **No** (sends `\x1b`, i.e. Escape).
- [ ] All three buttons are disabled while a response request is in-flight (local `responding` state is `true`).
- [ ] Buttons re-enable regardless of whether the HTTP request succeeded or failed (the `finally` block clears `responding`).

#### Approval actions

- [ ] Clicking **Yes** POSTs `{ text: "\r" }` to `POST /api/sessions/:id/inject`.
- [ ] Clicking **Yes, allow this session** POSTs `{ text: "\x1b[B\r" }` to `POST /api/sessions/:id/inject`.
- [ ] Clicking **No** POSTs `{ text: "\x1b" }` to `POST /api/sessions/:id/inject`.
- [ ] The server endpoint calls `injectText(session.pid, text)` (pipe-first, console-input fallback).
- [ ] On successful injection the server calls `stateManager.setNeedsPermission(sessionId, false)`, which clears `needsPermission` and `permissionPromptText`, records `permissionApprovedAt = Date.now()`, and broadcasts an updated snapshot.
- [ ] The endpoint responds `{ ok: true }` on success.

#### Injection failure

- [ ] If `injectText` throws, the server responds `HTTP 500` with `{ error: <message> }`.
- [ ] `stateManager.setNeedsPermission(sessionId, false)` is **not** called on failure; `needsPermission` remains `true`.
- [ ] The client `PermissionPrompt` component re-enables its buttons after the failed request (no crash or stuck UI).
- [ ] The failure is logged server-side with `[approve] error: ...`.
- [ ] The UI continues to show the permission prompt so the operator can retry.

#### 30 s suppression window

- [ ] After `setNeedsPermission(sessionId, false)` is called (approval path), `session.permissionApprovedAt` is set to the current timestamp.
- [ ] For 30 s after that timestamp, any call to `setNeedsPermission(sessionId, true)` from the screen reader is silently ignored.
- [ ] The transcript reader's `refreshTranscript` path also respects the suppression window: it will not re-set `needsPermission = true` within those 30 s even if the JSONL still contains a stale tool-use block.
- [ ] After 30 s the suppression window expires naturally; no explicit reset is needed.

#### State transitions after approval

- [ ] Once the operator sends a response and `setNeedsPermission(false)` is called, the session's `needsPermission` and `permissionPromptText` are cleared immediately and the updated snapshot is broadcast.
- [ ] The session's `state` field is left unchanged by the approval path; it will transition normally (e.g. to `working` or `thinking`) when the transcript file is next updated by Claude.
- [ ] If the transcript file updates within the suppression window and `result.needsPermission` is now false, `refreshTranscript` also clears `needsPermission` and `permissionPromptText` (the two paths are idempotent).

---

### Out of scope

- Auto-approving permission prompts without operator interaction.
- Detecting or handling permission prompts on non-Windows platforms (the checker returns `undefined` on non-Windows; the client still renders the prompt if the server sets the flag through another path).
- Subagent permission prompts are now partially handled: the secondary pattern update means `PermissionChecker` also detects subagent-style dialogs (e.g. "Yes, and allow X for this session"). What remains out of scope is the subagent worker badge — subagent workers still do not show the "⚠ approval" badge even when their parent session has `needsPermission === true`; only the parent session worker shows the badge.
- Rate-limiting or queuing multiple simultaneous approval requests from different browser tabs.
- Persisting `permissionApprovedAt` across server restarts.

---

### Open questions

- Should a failed injection automatically retry, or should it always require a manual re-click?
- Should the suppression window duration (30 s) be configurable via an environment variable?
- Should the **No** button's label be "No" or "Cancel / No" to better match the Claude UI wording ("Esc to cancel")?
- Is it correct to show the `PermissionPrompt` UI when the session's state is `working` (not just `waiting`)? The transcript may still show `waiting` while the screen shows the prompt.
