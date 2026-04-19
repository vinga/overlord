## Spec: OverlordSession entity — unify session-scoped persistence

**Goal:** Collapse five scattered session-scoped JSON stores into a single durable `OverlordSession` entity (one file per sessionId) plus a separate runtime-only `LiveSession` type, eliminating lifecycle bugs (notes leak, orphaned intent, archive index drift) and whole-room file rewrites.

**Placement:** _N/A_ (backend architectural change). UI impact limited to archive-row follow-up once the store is populated.

---

### Inputs / Triggers

- Server boot — `migrateLegacyStorage()` runs once, `sessionStore.loadAll()` hydrates from disk.
- Every durable-field mutation on a session (intent update, notes PUT, task create/update, archive, completion-hint set, ack flip, sessionType decision, sessionHistory append).
- Session deletion (`deleteSession` in `packages/server/src/index.ts`).
- Process shutdown — synchronous flush of pending debounced writes.

### Outputs / Side effects

- New directory `~/.claude/overlord/sessions/` containing one `{sessionId}.json` per session.
- Legacy files moved (not deleted) on first migration run to `~/.claude/overlord/.legacy-backup/{YYYYMMDD-HHmmss}/`.
- Marker file `~/.claude/overlord/.migration-v1-done` written after successful migration (prevents re-run).
- `OfficeSnapshot` broadcast remains byte-compatible with current clients (Session shape preserved at the wire).

---

### Server

#### New file `packages/server/src/session/sessionStore.ts`

```ts
export interface OverlordSession {
  // Identity
  sessionId: string;
  overlordId: string;
  sessionHistory?: Array<{ sessionId: string; attachedAt: number }>;
  provider?: SessionProvider;
  slug?: string;
  sessionType: 'embedded' | 'bridge' | 'plain' | 'ide' | 'raw';

  // Context (set at creation, rarely mutated)
  cwd: string;
  startedAt: number;
  proposedName?: string;
  color: string;
  model?: string;
  resumedFrom?: string;
  replacedBy?: string;
  transcriptPath?: string;
  bridgeMarker?: string;
  bridgePipeName?: string;
  historyOnly?: boolean;
  userAccepted?: boolean;

  // Snapshot-worthy summary fields
  lastActivity?: string;      // ISO; for closed sessions
  lastMessage?: string;

  // AI / UX state (previously scattered)
  intent?: string;            // from intent-summaries.json
  intentTurnCount?: number;
  intentUpdatedAt?: number;
  notes?: string;             // from notes.json
  planTasks?: Task[];         // kind='plan' tasks
  completionSummaries?: Task[];  // done tasks
  currentTask?: Task;         // active task
  completionHint?: 'done';    // from .hint file
  acknowledged?: boolean;     // from .ack file

  // Archive flag (replaces archive/index.json)
  archivedAt?: string;                     // ISO; presence = archived
  archivedTranscriptPath?: string;
  archivedRoomId?: string;                 // cwd slug at archive time
  archivedName?: string;
  archivedGitBranch?: string;
  archivedPullRequest?: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
  };
}

export interface LiveSession {
  overlord: OverlordSession;              // reference to persisted entity
  // Runtime-only fields
  pid: number;
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  subagents: Subagent[];
  ptyCompactItems?: ActivityItem[];
  ptyCompactBaseline?: number;
  ptyCompactBaselineAt?: number;
  ptyCompactBoundarySeen?: boolean;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  ideName?: string;
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  permissionApprovedAt?: number;
  permissionMode?: string;
  permissionModeLockedUntil?: number;
  pendingQuestion?: PendingQuestionSet;
  completionHintByUser?: boolean;
  manuallyDone?: boolean;
  currentTaskLabel?: string;
  requestSummary?: string;                // @deprecated
  isWorker?: boolean;
  staleCount?: number;
  bridgeTty?: string;
  bridgeDead?: boolean;
  ptySessionId?: string;
  ptyInputPendingSince?: number;
  loadedAt?: number;
}

export class SessionStore {
  loadAll(): Map<string, OverlordSession>;
  get(sessionId: string): OverlordSession | undefined;
  list(): OverlordSession[];
  listArchived(): OverlordSession[];
  listArchivedByCwd(cwd: string): OverlordSession[];
  upsert(session: OverlordSession): void;          // synchronous; used by migration
  patch(sessionId: string, partial: Partial<OverlordSession>): OverlordSession | undefined;
  setArchived(sessionId: string, fields: ArchiveFields): OverlordSession | undefined;
  remove(sessionId: string): void;                  // synchronous flush + delete file
  flushAll(): Promise<void>;                        // awaited on shutdown
}
```

**Write strategy:**
1. Patch merges into the in-memory Map, schedules a debounced flush (200ms per sessionId).
2. Per-session Promise chain serializes writes; concurrent patches coalesce before flush.
3. Flush writes to `{id}.json.tmp` then `fs.renameSync` over `{id}.json` (atomic on POSIX).
4. `remove()` cancels the debounce, deletes the file synchronously.
5. Process `SIGINT`/`SIGTERM` handler awaits `flushAll()` before exit.

**Composed broadcast view:**
StateManager's `getSnapshot()` builds the wire `Session` by spreading OverlordSession + LiveSession fields into the existing flat shape, so clients see no change.

#### New file `packages/server/src/session/migrateLegacyStorage.ts`

```ts
export function migrateLegacyStorage(store: SessionStore): MigrationResult;
```

Runs once on boot if `~/.claude/overlord/.migration-v1-done` doesn't exist and `~/.claude/overlord/sessions/` is empty.

Sources merged (in this order, later sources overwrite only the fields they own):
1. `~/.claude/overlord/known-sessions.json` → identity/context fields.
2. `~/.claude/overlord/intent-summaries.json` → `intent`, `intentTurnCount`, `intentUpdatedAt`.
3. `packages/server/data/notes.json` → `notes`.
4. `~/.claude/overlord/rooms/*.tasks.json` → split by sessionId into `planTasks`, `completionSummaries`, `currentTask`.
5. `~/.claude/overlord/tasks/*.hint` and `*.ack` → `completionHint`, `acknowledged`.
6. `~/.claude/overlord/archive/index.json` → archive fields; archive-only sessionIds create minimal records.
7. `~/.claude/overlord/colors.json` → `color` fallback.

On success, move all consumed files to `~/.claude/overlord/.legacy-backup/{timestamp}/`. On any verification mismatch, abort without touching legacy files.

#### Refactored call sites (Phase 3)

- `packages/server/src/ai/intentSummary.ts` — delete `STORE_PATH`, `load()`, `persist()`, `cache` Map. All reads/writes via `sessionStore`.
- `packages/server/src/api/apiRoutes.ts` — delete `NOTES_FILE`, `loadNotes`, `saveNotes`. Notes routes delegate to `sessionStore`. Archive routes thin out.
- `packages/server/src/ai/taskStorage.ts` — drop room-tasks file; reimplement CRUD on `sessionStore`. `.hint`/`.ack` fold into `completionHint`/`acknowledged`.
- `packages/server/src/archive/archiveManager.ts` — drop `index.json`. `archive()` copies transcript + `sessionStore.setArchived(...)`. `list*`/`isArchived`/`get` delegate.
- `packages/server/src/session/stateManager.ts` — `loadKnownSessions` becomes a `sessionStore.loadAll()` wrapper; every durable-field assignment goes through `sessionStore.patch`.
- `packages/server/src/index.ts` — `deleteSession` replaces per-file cleanup with one `sessionStore.remove(sessionId)`.

### Client

- `packages/client/src/types.ts` — add `archivedAt?: string` to `Session`; add `intent?: string` and `notes?: string` to `ArchiveEntry`.
- `packages/client/src/components/Room.tsx` — after Phase 3, extend `archiveEntryDesc` block (lines 887–889) to render intent (dim italic) and notes (muted) alongside `lastMessage`.
- `packages/client/src/components/Room.module.css` — add `.archiveEntryIntent`, `.archiveEntryNotes` styles.

---

### Acceptance Criteria

**Server — SessionStore**
- [ ] `SessionStore.loadAll()` returns a Map whose size equals the count of `{id}.json` files in `~/.claude/overlord/sessions/`.
- [ ] `patch(id, {intent: 'x'})` followed by `get(id)` returns an OverlordSession with `intent === 'x'` in <1ms (in-memory hit).
- [ ] Concurrent `patch(id, {intent: 'a'})` + `patch(id, {notes: 'b'})` fired in same tick produce a final file containing both fields (merged, no lost write).
- [ ] `remove(id)` deletes `{id}.json` and the in-memory entry; subsequent `get(id)` returns undefined.
- [ ] Writes are atomic — a reader mid-write never sees truncated JSON (tmp + rename).
- [ ] `flushAll()` on shutdown completes all pending debounced writes before process exit.

**Server — Migration**
- [ ] Running migration with a seeded fixture (1 known-session, 1 intent record, 1 notes entry, 1 plan task, 1 archive entry, all same sessionId) produces a single `{id}.json` with all five fields merged.
- [ ] Archive-only sessionId (no known-session, no intent) produces a minimal OverlordSession with `archivedAt` set and no crash.
- [ ] After successful migration, `.legacy-backup/{timestamp}/` contains all consumed legacy files; originals are absent.
- [ ] Re-running boot with marker file present is a no-op (exits early).
- [ ] Verification mismatch (seeded file corrupt) aborts migration without touching legacy files and without writing marker.

**Server — Refactored call sites**
- [ ] `IntentSummarizer` no longer references `STORE_PATH`; grep for `intent-summaries.json` in `packages/server/src/` returns zero hits outside the migration module.
- [ ] Notes routes PUT/GET go through `sessionStore`; grep for `notes.json` in `packages/server/src/` returns zero hits outside migration.
- [ ] `archiveManager.isArchived(id)` returns `sessionStore.get(id)?.archivedAt !== undefined`.
- [ ] `deleteSession` invocation removes a session's `{id}.json`; no orphan notes/intent/task files remain for that id.
- [ ] After `sessionStore.remove(id)`, `sessionStore.list().find(s => s.sessionId === id)` returns undefined.

**Server — Startup equivalence**
- [ ] Boot a server with the new store + seeded migration → capture `OfficeSnapshot` JSON. Restart → capture again. Diff empty modulo `loadedAt` and dynamic `lastActivity` timestamps.
- [ ] Empty-state boot (no `~/.claude/overlord/` directory) produces an empty store without crashing.

**Client**
- [ ] `GET /api/archive/by-room/:roomId` response includes `intent` and `notes` fields when present on the OverlordSession.
- [ ] Archive row in `Room.tsx` renders intent line (when present), lastMessage line (when present), notes line (when present), each styled distinctly.
- [ ] Chrome DevTools MCP screenshot confirms the three lines render correctly for a session that has all three; fallback renders cleanly when any subset is absent.

**Performance**
- [ ] `sessionStore.loadAll()` for 500 session files completes in <150ms on a dev Mac.
- [ ] A single `patch()` call has p50 <0.5ms in-memory; flush latency is not observed by the patch caller (fire-and-forget).
- [ ] Total write volume for a high-churn session (10 task updates + 5 intent refreshes + 3 notes edits in 1 minute) is ≤N flushes where N = number of 200ms debounce windows that fire, not one-per-patch.

---

### Out of scope

- Pruning old closed sessions from the store. Files accumulate unbounded for v1; a `prune()` helper is a later change.
- Schema versioning / migration of `OverlordSession` itself. v1 assumes all files are v1 shape.
- Moving git status (branch / PR) from live computation into the store. Those stay computed on demand via `readGitStatus`.
- Transcript content — remains on disk under `~/.claude/projects/{slug}/{sessionId}.jsonl` (and archive copy); the store only holds paths.
- ActivityFeed persistence. Transcript-derived; rebuilt on demand by `transcriptReader`.

### Open questions

1. Should `known-sessions.json` be folded into the store as well (migrate once, then stop writing it) or left as a redundant secondary index? Suggest: fold in — every field it holds is already on OverlordSession; dual maintenance is the bug we're fixing.
2. Should migration run lazily (only when the first legacy file is read) or eagerly at boot? Suggest: eagerly at boot — deterministic, one-time, avoids interleaving of old + new writes.
3. Should the `.legacy-backup/{timestamp}` dir be pruned automatically after N days? Suggest: no — leave it indefinitely; the user can delete manually once they're confident.
4. Should `color` be persisted on the session (current behavior via `colors.json`), or always recomputed from the existing color-assignment algorithm? Suggest: persist it. Changing the algorithm shouldn't recolor existing sessions.
