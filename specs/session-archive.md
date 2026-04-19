# Spec: Session Archive (per-room, manual)

**Goal:** Menu action to archive a session — copies transcript to non-monitored folder, hides from active room view, accessible via a collapsed "Archive" section on the room it belonged to.

**Inputs / Triggers:** "Archive" action from session context menu or DetailPanel.

**Outputs / Side effects:**
1. Transcript copied to `~/.claude/overlord/archive/{slug}/{sessionId}.jsonl`
2. Entry appended to `~/.claude/overlord/archive/index.json` — `{ sessionId, slug, cwd, roomKey, name, archivedAt, pid }`
3. Session removed from live office snapshot (and from `known-sessions.json`)
4. `GET /api/archive/by-room/:roomKey` returns archived entries for that room
5. `GET /api/archive/:sessionId/transcript` returns archived JSONL
6. WS broadcast `archive:added` so other clients update counts
7. Archive folder is **not** watched by `transcriptWatcher` / `sessionWatcher`
8. Archived sessions are **not** included in any search / name lookup / PR cache / task storage

**UI:**
- Each room footer: small "Archive (N)" pill, hidden if N=0
- Click expands inline list below the room's active workers
- Entries styled muted/grey, one line: name + archived timestamp
- Clicking opens DetailPanel in read-only mode — transcript only, no terminal, no inject, no edits
- DetailPanel fetches transcript lazily on open (not preloaded)

**Acceptance Criteria:**
- [ ] Archive action exists in DetailPanel (and/or worker context menu)
- [ ] Clicking archives: copies file, writes index, removes from office snapshot
- [ ] Archive folder is ignored by watchers (verify paths)
- [ ] Room shows "Archive (N)" pill only when N > 0
- [ ] Expanded list renders archived entries for that room, newest first
- [ ] Clicking archived entry opens read-only DetailPanel with transcript content
- [ ] Archived sessions absent from search / name resolution / PR cache
- [ ] Idempotent: re-archiving a session is a no-op

**Out of scope:**
- Automatic archive on /clear
- Delete / restore from archive
- Search across archive
- Global cross-room archive view

**Open questions:**
- If session is still alive (pid active), archiving: close it + archive, or block with warning?
- Should archive pill show count badge per room, or just "Archive"?
