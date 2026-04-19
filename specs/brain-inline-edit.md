## Spec: Brain tab inline edit

**Goal:** Let the user edit identity (CLAUDE.md) and memory files inline from the Brain tab expanded-file view and save changes back to disk.

**Placement:** Brain tab → Identity card (FileRow) and Memory card (FileRow). When a file is expanded, an "Edit" button swaps the read-only view for a textarea with Save / Cancel.

---

### Inputs / Triggers

- User expands an identity or memory file row in the Brain tab.
- User clicks the **Edit** button in the expanded view.
- User edits text in a textarea, then clicks **Save** or **Cancel**.

### Outputs / Side effects

- On **Save**: write textarea contents verbatim to the file via `PUT /api/brain/file`. File mtime updates. Brain-context cache entry for the cwd is invalidated so the next `/api/brain` call re-reads. UI reloads the file contents.
- On **Cancel**: discard edits, return to read-only view using the originally loaded contents.
- No other side effects (no auto-refresh of other clients, no broadcast).

---

### Server

**New endpoint:** `PUT /api/brain/file` in `packages/server/src/api/apiRoutes.ts`.

Request:
```
PUT /api/brain/file
Content-Type: application/json
{ "cwd": string, "path": string, "content": string }
```

Response:
```
200 { ok: true, path: string, totalLines: number }
400 { error: "cwd required" | "path required" | "content must be a string" | "not a file" }
403 { error: "path outside allowed scope" | "path type not editable" }
404 { error: "unknown cwd" | "file not found" }
500 { error: string }
```

Algorithm:
1. Validate `cwd` and `path` are non-empty strings; validate `content` is a string (may be empty).
2. Reject if `cwd` is not a known room cwd (mirrors `GET /api/brain/file`).
3. Resolve `path` and verify it is inside `~/.claude/` or under the room `cwd` (same scope as read).
4. Additionally restrict write scope: only allow paths whose basename is `CLAUDE.md` **or** whose dirname ends with `/memory` under `~/.claude/projects/<slug>/memory/*.md`. Anything else → 403 `path type not editable`.
5. If the file exists, assert it is a regular file. Overwrite with `fs.writeFileSync(resolved, content, 'utf-8')`.
6. Invalidate the brain cache for the cwd: export `invalidateBrainCache(cwd: string)` from `brain/brainContext.ts` and call it after a successful write.
7. Respond with total line count of the written file.

**Cache change:** add `export function invalidateBrainCache(cwd: string): void` in `packages/server/src/brain/brainContext.ts` that removes the entry from the `cache` map.

### Client

**Types:** none new — existing `FileViewState` re-used.

**Hook:** extend `useFileContents` in `packages/client/src/components/BrainTab.tsx` with `save(filePath, content): Promise<void>`. On success, refresh local `FileViewState` with the new content and invalidate nothing else — the next brain refresh picks up line counts.

**Render:** in `FileRow`, when expanded and content has loaded, show:
- an **Edit** button (top-right of the expansion) in read mode
- when clicked, swap `<pre>` for a `<textarea>` prefilled with `fileState.content`, plus **Save** and **Cancel** buttons
- while saving, disable both buttons and show `Saving…` on the Save button
- on save success, exit edit mode and show the new contents
- on save error, keep edit mode open, display the error near the buttons

**Styling:** reuse existing `fileExpansion` block, add a `.editActions` row and `.editTextarea` class in `BrainTab.module.css`. Textarea is monospace, min-height ~300px, full width, resizable vertically.

**UX rules:**
- Edit button only appears for identity and memory file rows (not skills/agents/hooks/etc.).
- Edit button is disabled while the file is loading or errored.
- Cancel always reverts to the last successfully loaded content; it does not re-fetch.
- Saving a memory entry's file does not modify the MEMORY.md index; only the file being edited is touched.
- Brain refresh is NOT auto-triggered after save (keep scroll state). The user can click Refresh manually.

---

### Acceptance Criteria

**Server**
- [ ] `PUT /api/brain/file` accepts JSON body `{ cwd, path, content }` and writes the file on success.
- [ ] Returns 403 for paths outside `~/.claude/` and the room cwd.
- [ ] Returns 403 for paths inside allowed scope whose basename is not `CLAUDE.md` and that are not inside `~/.claude/projects/<slug>/memory/`.
- [ ] Returns 404 when `cwd` is not a known room cwd.
- [ ] After a successful write, a subsequent `GET /api/brain?cwd=…` returns the updated `firstLine`/`lineCount` for that file within one request (cache invalidated).
- [ ] Empty-string `content` is allowed and truncates the file.

**Client**
- [ ] Expanding a CLAUDE.md file shows an Edit button; clicking it switches to a textarea prefilled with the file's content.
- [ ] Expanding a memory entry file (row in the Memory card) shows an Edit button with the same behavior.
- [ ] Expanding a skill/agent file does NOT show an Edit button.
- [ ] Clicking Save posts to `PUT /api/brain/file` and, on 200, exits edit mode with the updated content visible.
- [ ] Clicking Cancel discards edits and returns to read-only view with the pre-edit content.
- [ ] If the save request errors, edit mode stays open, textarea keeps the in-progress text, and the error message is shown next to the buttons.
- [ ] The Edit button is hidden while loading or on error before content is available.

**Performance**
- [ ] Save round-trip completes in <300ms p50 for a 10KB file on localhost.
- [ ] Toggling edit mode does not re-fetch the file (operates on already-loaded content).

---

### Out of scope

- Editing skills, agents, hooks, MCP servers, permissions, or `MEMORY.md` index.
- Creating new files from the Brain tab.
- Deleting files.
- Diff view / conflict detection with concurrent edits.
- Broadcasting changes to other connected clients.

### Open questions

1. Should we also let the user edit `MEMORY.md` (the index)? Suggest: no — the index is auto-maintained; out of scope.
2. Should we auto-refresh the whole brain after save to pick up new line counts in the header? Suggest: no — cache is invalidated so the next manual refresh is accurate; avoid scroll-jank.
3. Max file size for write? Suggest: reject payloads >1 MB to match sane CLAUDE.md bounds.
