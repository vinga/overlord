# Plan: Brain tab inline edit

Derived from `specs/brain-inline-edit.md`.

## Server

- [ ] **S1. Add `invalidateBrainCache(cwd)` to `packages/server/src/brain/brainContext.ts`** — exported function that deletes the cache entry. (AC: server cache invalidation)
- [ ] **S2. Add `PUT /api/brain/file` in `packages/server/src/api/apiRoutes.ts`** — validates cwd/path/content, reuses existing scope check, adds additional type gate (CLAUDE.md basename OR inside `~/.claude/projects/<slug>/memory/`), writes file, invalidates cache, returns `{ ok, path, totalLines }`. (AC: accepts JSON body; 403 out-of-scope; 403 wrong type; 404 unknown cwd; empty content allowed; 1MB cap)
- [ ] **S3. Wire body parser for the route** — ensure `express.json()` covers the new route (existing usage in `/api/open-file` for reference). (AC: JSON body parsed)

## Client

- [ ] **C1. Extend `useFileContents` with `save(path, content)`** in `packages/client/src/components/BrainTab.tsx` — calls `PUT /api/brain/file`, on success updates local `FileViewState.content`/`totalLines`, returns or throws. (AC: save round-trip updates local state)
- [ ] **C2. Add edit-mode state to `FileRow`** — `editing`, `draft`, `saving`, `saveError`. Show Edit button in read view; on click, populate draft from current content and enter edit mode. (AC: expand shows Edit; Cancel reverts; error keeps mode open)
- [ ] **C3. Only expose `editable` prop for Identity and Memory rows** — thread a boolean from the parent call sites. Skills/agents keep their existing `DefinitionRow` untouched. (AC: skills/agents have no Edit button)
- [ ] **C4. Add `.editTextarea` and `.editActions` styles in `BrainTab.module.css`** — monospace, resizable textarea; right-aligned button row. (AC: looks polished)

## Verification

- [ ] **V1. Walk acceptance criteria** — re-read spec, mark each AC verified or flag blockers.
- [ ] **V2. Browser / self-verify** — at `http://localhost:5173` (start dev servers if down), open Brain tab for a room, edit a CLAUDE.md line, save, expand again, confirm new content. Repeat with a memory file. Confirm skill row has no Edit button. Check console for errors.
- [ ] **V3. Server smoke test** — curl `PUT /api/brain/file` with allowed path, disallowed path (expect 403), and unknown cwd (expect 404).
