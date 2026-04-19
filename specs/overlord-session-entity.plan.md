# Plan: OverlordSession entity — unify session-scoped persistence

Spec: `specs/overlord-session-entity.md`. Walk: Server → Client → Verification.

Phases are sequenced; each phase's steps must complete before the next begins. AC refs below point to lines under "Acceptance Criteria" in the spec.

## Server

### Phase 1 — Types + SessionStore (no caller changes)
- [ ] Add `OverlordSession` and `LiveSession` interfaces to `packages/server/src/types.ts`. Keep existing `Session` interface as the broadcast view. → AC: SessionStore.loadAll (shape only)
- [ ] Create `packages/server/src/session/sessionStore.ts` with in-memory Map, atomic tmp+rename write, per-session Promise chain, 200ms debounce, `loadAll/get/list/listArchived/listArchivedByCwd/upsert/patch/setArchived/remove/flushAll`. → AC: `patch(id,…)` in-memory, concurrent patch merge, atomic write, flushAll on shutdown
- [ ] Unit tests `packages/server/src/__tests__/sessionStore.test.ts`: loadAll count, patch-merge, concurrent-patch merge, atomic write (read during write), flushAll. → AC: Concurrent merge, atomic write
- [ ] Wire shutdown hook in `packages/server/src/index.ts` (SIGINT/SIGTERM) to `await sessionStore.flushAll()` before exit. → AC: flushAll on shutdown

### Phase 2 — Migration + startup wiring
- [ ] Create `packages/server/src/session/migrateLegacyStorage.ts` that reads the six legacy sources (known-sessions, intent-summaries, notes.json, rooms/*.tasks.json, tasks/*.hint+*.ack, archive/index.json, colors.json), merges per sessionId, writes via `sessionStore.upsert`, verifies counts, moves legacy to `.legacy-backup/{timestamp}/`, writes marker file. → AC: All four migration criteria
- [ ] Add boot sequence in `packages/server/src/index.ts`: `migrateLegacyStorage(sessionStore)` → `sessionStore.loadAll()` → `new StateManager(sessionStore, …)`. → AC: Startup equivalence
- [ ] Dual-write guard: during Phase 2, old writers keep writing; new writes additionally go through sessionStore. Remove after Phase 3.

### Phase 3 — Flip callers subsystem by subsystem
- [ ] **Intent**: `packages/server/src/ai/intentSummary.ts` — drop `STORE_PATH`, `load()`, `persist()`, `cache`. Reads use `sessionStore.get(id).intent`. Writes use `sessionStore.patch(id, {intent, intentTurnCount, intentUpdatedAt})`. → AC: grep intent-summaries.json = 0 outside migration
- [ ] **Notes**: `packages/server/src/api/apiRoutes.ts` — delete `NOTES_FILE`, `loadNotes`, `saveNotes`; routes delegate to sessionStore. → AC: grep notes.json = 0 outside migration
- [ ] **Tasks**: `packages/server/src/ai/taskStorage.ts` — reimplement CRUD on sessionStore. `.hint`/`.ack` fold into `completionHint`/`acknowledged`. → AC: Plan + summaries survive on OverlordSession
- [ ] **Archive**: `packages/server/src/archive/archiveManager.ts` — drop index.json. `archive()` copies transcript then `sessionStore.setArchived(...)`. `list*/isArchived/get` delegate to sessionStore. → AC: `isArchived(id)` = store lookup
- [ ] **StateManager**: `packages/server/src/session/stateManager.ts` — `loadKnownSessions` wraps `sessionStore.loadAll` + LiveSession construction. `addOrUpdate`/`addRawSession`/`addHistoryOnlyRawSession` patch the store on durable-field changes. `getSnapshot()` composes broadcast Session from OverlordSession + LiveSession. → AC: Startup equivalence diff empty
- [ ] **Delete**: `packages/server/src/index.ts` `deleteSession` replaces five per-file cleanups with `sessionStore.remove(id)`. Keep transcript/PTY/bridge/shell-history/blocklist cleanup. → AC: No orphan notes/intent/task files after delete

### Phase 4 — Remove legacy code
- [ ] Delete all remaining references to `intent-summaries.json`, `notes.json`, `rooms/*.tasks.json`, `tasks/*.hint/*.ack`, `archive/index.json`, `known-sessions.json` (outside migration module). Grep assertions pass with 0 hits.
- [ ] Leave `.legacy-backup/` in place; optionally bump marker to v2 if schema evolved during flip.

## Client

### UI follow-up (originally-requested feature)
- [ ] `packages/client/src/types.ts` — add `intent?: string`, `notes?: string` to `ArchiveEntry`; add `archivedAt?: string` to `Session`. → AC: API response shape
- [ ] `packages/client/src/components/Room.tsx` — in the archive row block around lines 887–889, render:
  - intent line (gated on `entry.intent`) above lastMessage, class `.archiveEntryIntent`
  - existing lastMessage line (gated on `entry.lastMessage`)
  - notes line (gated on `entry.notes`) below, class `.archiveEntryNotes`
  → AC: Three lines render distinctly
- [ ] `packages/client/src/components/Room.module.css` — add `.archiveEntryIntent` (italic, dim, 11px, clamp 2 lines) and `.archiveEntryNotes` (muted, 11px, clamp 2 lines). → AC: Visual distinction

## Verification

- [ ] **Walk acceptance criteria** — tick every AC in the spec, linking to the implementing step/commit.
- [ ] **Seeded migration test** — script at `packages/server/src/__tests__/migration.test.ts` seeds fixtures, runs migration, asserts merged output and backup dir.
- [ ] **Concurrent write stress** — inline test: three patches same sessionId, same tick → final file contains all three.
- [ ] **Archive roundtrip** — via running server: archive a session → verify `{id}.json` has `archivedAt`, transcript copied, room archive list unchanged visually.
- [ ] **Delete roundtrip** — delete a session with notes+intent+tasks → single file removed, no orphans.
- [ ] **Restart equivalence** — capture `OfficeSnapshot` at t0, restart, capture at t1. Diff empty modulo `loadedAt`.
- [ ] **Browser / self-verify** — Chrome DevTools MCP screenshot of archive row rendering intent + lastMessage + notes together for a session that has all three.
