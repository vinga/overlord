## Spec: Resume archived session

**Goal:** Let users bring an archived session back to life in one of two ways: restore it in place, or branch a new session off it.

**Inputs / Triggers:**
- User opens an archived session in DetailPanel (existing flow).
- Two new actions surface in the header (or overflow menu): **Resume this** and **Resume as clone**.
- Both actions are only visible when `selectedSession.isArchived === true`.

**Outputs / Side effects:**

### Resume this
- Server endpoint: `POST /api/archive/:sessionId/unarchive`.
- Moves the transcript file back from the archive directory to its original Claude projects path (reverse of archive).
- Removes the entry from `~/.claude/overlord/archive/index.json`.
- Restores color binding for that `overlordId` if needed.
- Re-registers the session in `StateManager` so the next snapshot includes it again (state `closed`, since no PID is alive).
- Client then invokes the existing **resume** flow against that sessionId (same path as resuming any closed session) — typically spawns a new PTY in the original cwd with `--resume {sessionId}`.
- Archive entry disappears from the Room's archive list.

### Resume as clone
- Archive entry stays intact.
- Server endpoint: `POST /api/archive/:sessionId/clone` — returns the source transcript path and cwd.
- Client triggers the existing **clone** flow (same as `onCloneSession`), pointing at the archived transcript as the source. A new sessionId is generated; the new session shows up as a fresh live session in the same room.
- Original archive entry remains; the clone is independent of it.

**Acceptance Criteria:**
- [ ] When viewing an archived session in DetailPanel, two buttons appear: "Resume this" and "Resume as clone".
- [ ] Neither button appears for non-archived sessions.
- [ ] Clicking "Resume this" removes the entry from the archive list, restores the transcript to Claude's projects dir, and starts a resumed session in the original cwd.
- [ ] After "Resume this" completes, DetailPanel switches from archived view to the live session (tabs + state badge return).
- [ ] Clicking "Resume as clone" leaves the archive entry untouched and spawns a new live session in the same room, seeded from the archived transcript.
- [ ] Both flows work regardless of whether the original `overlordId` is currently held by another live session.
- [ ] If unarchive collides with an existing session file at the destination, server returns a clear error and the archive entry is left intact.
- [ ] Color is preserved: resumed session uses the archived `color`; clone gets a fresh color via the normal allocation path.

**Out of scope:**
- Bulk unarchive.
- Editing archived transcripts.
- Partial restore (e.g., notes only).
- UI for browsing archive history across rooms.

**Open questions:**
- Should "Resume this" auto-send any warm-up input, or just spawn and let the user type? (Proposal: just spawn, identical to resuming a recently-closed session.)
- Do we want a confirmation modal on "Resume this" (because it mutates the archive), or is a toast enough? (Proposal: toast only — the action is reversible by re-archiving.)
- Clone flow today seeds from a live transcript; does the existing code path accept an arbitrary transcript path, or does it need a small extension?
