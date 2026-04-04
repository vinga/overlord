## Spec: Fork From Here

**Goal:** Allow the user to fork a Claude Code session from any point in its conversation history, creating a new session that contains only the transcript up to that point, immediately resumable via `claude --resume`.

**Inputs / Triggers:** User clicks a "fork" button on a message segment in the detail panel's activity feed.

**Outputs / Side effects:**
- A new `.jsonl` transcript file is written to the same project slug directory with a new UUID session ID
- The new file contains all lines from the original transcript up to and including the selected message (and its associated tool calls / thinking blocks)
- UI displays a toast/notification confirming the fork with the new session ID

---

### UI (Client)

- Add a small fork button (scissors or branch icon) next to the existing `raw` toggle on each **message segment** (entries with `kind: 'message'`, i.e. user or assistant turns — NOT tool entries or thinking blocks)
- The button is muted/hidden by default and appears on hover, matching the style of the existing raw toggle
- On click: call `POST /api/fork-session` with `{ sessionId, messageIndex }`
- `messageIndex` is the 0-based index of the clicked message segment among all message segments in the activity feed (counting only `kind: 'message'` entries, in order)
- On success: show a brief toast/notification with the new session ID and the file path
- On error: show an error toast with the failure reason

### Server

- New endpoint: `POST /api/fork-session`
  - Request body: `{ sessionId: string, messageIndex: number }`
  - Reads the original `.jsonl` file for the given session
  - Iterates lines, counting `user` and `assistant` type lines (these correspond to message segments in the activity feed). System lines, tool-result lines, and other non-message lines are not counted but are included in output if they precede the cutoff.
  - The cutoff is: include everything up to and including the line corresponding to `messageIndex`, plus any subsequent non-message lines that belong to that assistant turn (tool calls, thinking blocks) — i.e., include all lines until the next `user` or `assistant` message line, or EOF.
  - Generates a new UUID as the session ID
  - Writes a new `.jsonl` file at `~/.claude/projects/{slug}/{newSessionId}.jsonl`, preserving exact bytes of each included line (no re-serialization)
  - Returns `{ newSessionId: string, path: string }`
  - Error responses:
    - `404` if the original transcript file cannot be found
    - `400` if `messageIndex` is out of bounds (negative or exceeds the number of message segments)
    - `500` for unexpected file system errors

### Cutoff Logic (detailed)

Given a `.jsonl` file where each line is a JSON object:

1. Parse each line and classify it: `message` (type is `user` or `assistant`) vs `non-message` (type is `system`, or any other line like tool results)
2. Assign a 0-based message index to each `message` line, in order of appearance
3. Find the line with message index equal to `messageIndex` — call this the "cutoff message line"
4. Include all lines from the start of the file up to and including the cutoff message line
5. Additionally include any contiguous non-message lines immediately after the cutoff message line (these are tool calls, thinking blocks, etc. that belong to that turn) — stop when hitting the next message line or EOF
6. Write these lines verbatim (exact bytes, newlines preserved) to the new file

### Resumability

The forked `.jsonl` file must be immediately resumable via `claude --resume <newSessionId>`. Claude Code discovers sessions by scanning the project directory for `.jsonl` files, so placing the file in the correct slug directory is sufficient — no additional metadata file is needed.

---

**Acceptance Criteria:**
- [ ] Fork button appears on hover for each message segment (`kind: 'message'`) in the detail panel activity feed
- [ ] Fork button does NOT appear on tool entries or thinking blocks
- [ ] Button style is subtle and consistent with the existing raw toggle
- [ ] Clicking fork calls `POST /api/fork-session` with the correct `sessionId` and `messageIndex`
- [ ] Server reads the original `.jsonl` and writes a new file truncated at the correct point
- [ ] Cutoff includes trailing non-message lines (tool calls, thinking) that belong to the last included message turn
- [ ] Lines are preserved as exact bytes (no re-serialization)
- [ ] New `.jsonl` is placed in the same project slug directory as the original
- [ ] New session is resumable via `claude --resume <newSessionId>`
- [ ] UI shows a success toast/notification after fork with the new session ID
- [ ] UI shows an error toast if the fork fails
- [ ] Server returns 404 if transcript file is missing
- [ ] Server returns 400 if messageIndex is out of bounds

**Out of scope:**
- Auto-launching the forked session in a PTY terminal (follow-up)
- "Fork & Resume in terminal" combined action (follow-up)
- Forking subagent transcripts
- Editing or modifying message content during fork
- Making the forked session appear in the office view before someone resumes it

**Open questions:**
- Should the forked session appear automatically in the office view? Probably not until someone actually resumes it with `claude --resume`.
- Should we add a "Fork & Resume in terminal" combined action? Deferred to a follow-up spec.
