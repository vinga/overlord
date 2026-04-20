## Spec: Plan entity — first-class, file-backed, overlord-scoped

**Goal:** Replace the nested `OverlordSession.planTasks[]` array with a standalone `Plan` entity — one markdown file per plan, stored in central overlord storage alongside existing per-overlord and per-room data, FK'd to `overlordId` — so plans are Claude-independent (user-authored or Claude-derived) and a single session can own many plans across its lifetime.

**Placement:** Detail panel gets a new "Plans" subtab beside the existing chat/terminal tabs. Worker card plan pill (existing) reflects the latest plan per overlord. Room page gains an "All plans" collapsible list. Global cross-room plans view out of scope for v1 (see Out of scope).

---

### Inputs / Triggers

- User creates a plan manually via "New plan" button in the Plans subtab.
- User edits a plan's title, body, or status.
- User deletes a plan.
- Transcript parser detects `ExitPlanMode` tool_use → creates/updates a Claude-sourced plan file.
- Server boot — `planStore.loadAll()` scans `~/.claude/overlord/plans/`.
- Migration — one-time on boot: existing `planTasks[]` entries in OverlordSession files are converted to plan files, then stripped from OverlordSession.

### Outputs / Side effects

- New central directory `~/.claude/overlord/plans/` containing one `{planId}.md` per plan (flat, mirrors `~/.claude/overlord/overlord-sessions/`).
- Plan file is markdown with YAML frontmatter (metadata) + markdown body.
- `OverlordSession.planTasks[]` removed from the schema and from all session files (migration strips it).
- `OfficeSnapshot.sessions[i].planTasks` replaced with a projected view computed from plan files (wire-compat: same shape, same field name).
- New REST endpoints under `/api/plans`.
- WebSocket `plan:changed` event on create/update/delete so clients refresh without polling.

---

### Server

#### New file `packages/server/src/plans/planStore.ts`

```ts
export type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
export type PlanSource = 'claude' | 'user';

export interface PlanMeta {
  planId: string;                // ulid, 26 chars
  overlordId: string;            // FK → OverlordSession
  cwd: string;                   // absolute path, room key
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  title: string;                 // ≤120 chars, derived from first H1 if absent
  status: PlanStatus;
  source: PlanSource;
  claudePlanToolUseId?: string;  // dedup key when source='claude'
}

export interface Plan extends PlanMeta {
  body: string;                  // markdown, no frontmatter
}

export class PlanStore {
  loadAll(): Map<string, Plan>;
  get(planId: string): Plan | undefined;
  list(): Plan[];
  listByOverlord(overlordId: string): Plan[];
  listByCwd(cwd: string): Plan[];
  create(input: { overlordId: string; cwd: string; title: string; body: string; source: PlanSource; claudePlanToolUseId?: string }): Plan;
  patch(planId: string, partial: Partial<Pick<Plan, 'title' | 'body' | 'status'>>): Plan | undefined;
  remove(planId: string): boolean;
  upsertFromClaude(input: { overlordId: string; cwd: string; claudePlanToolUseId: string; body: string; status: PlanStatus }): Plan;
  flushAll(): Promise<void>;
}
```

**File layout:**
- Path: `~/.claude/overlord/plans/{planId}.md` (flat, mirrors `overlord-sessions/` layout).
- Frontmatter: YAML block between `---` delimiters containing all `PlanMeta` fields.
- Body: markdown after the closing `---`.
- Title resolution: `title` field in frontmatter is authoritative; if the body starts with `# <heading>`, the heading is used for display when frontmatter title is empty.

**Write strategy:**
1. In-memory `Map<planId, Plan>` keyed by planId; secondary indexes for `overlordId → planId[]` and `cwd → planId[]`.
2. `patch()` mutates memory, schedules a debounced flush (200ms per planId), serialized per-planId Promise chain.
3. Flush writes to `{planId}.md.tmp` then `fs.renameSync` to `{planId}.md` (atomic).
4. `remove()` cancels pending debounce and deletes the file synchronously.
5. `SIGINT`/`SIGTERM` handler awaits `flushAll()`.

**Load strategy (`loadAll`):**
1. `fs.readdir(~/.claude/overlord/plans/)`, read each `*.md` file.
2. Parse frontmatter; skip files with missing required fields (log warning).
3. Build secondary indexes (`overlordId → planId[]`, `cwd → planId[]`).

**Chokidar watcher:**
- Watch `~/.claude/overlord/plans/*.md` for external edits (user editing files directly).
- Debounced 100ms re-parse on change; emit `plan:changed` WS event on diff.

#### New file `packages/server/src/plans/migrateLegacyPlanTasks.ts`

```ts
export function migrateLegacyPlanTasks(sessionStore: SessionStore, planStore: PlanStore): MigrationResult;
```

Runs once on boot if marker `~/.claude/overlord/.plans-migration-v1-done` absent.

1. Iterate all OverlordSessions in `sessionStore`.
2. For each session with `planTasks` array non-empty:
   - For each task, derive `claudePlanToolUseId` from `task.planToolUseId` (existing field).
   - Write a plan file via `planStore.create({ overlordId, cwd: session.cwd, title: task.summary ?? 'Plan', body: task.planContent ?? '', source: 'claude', claudePlanToolUseId })` into `~/.claude/overlord/plans/`.
   - Map `task.status` → plan status: `approved`→`active`, `rejected`→`archived`, otherwise `draft`.
3. `sessionStore.patch(overlordId, { planTasks: undefined })` to strip the field.
4. On full success, write marker file. On any error, abort without writing marker (migration retries next boot).

#### Transcript integration — `packages/server/src/session/transcriptReader.ts`

- Existing `ExitPlanMode` parser at lines 676–690 stops writing to `planTasks[]` on the overlord.
- Replace with call to `planStore.upsertFromClaude({ overlordId, cwd, claudePlanToolUseId: toolUseId, body: planBody, status })`.
- Status mapping: tool result matches `/approved/i` → `'active'`; matches `/rejected/i` → `'archived'`; otherwise `'draft'`.
- `planStore` dedupes by `claudePlanToolUseId` — reparsing the same transcript is idempotent.

#### New endpoints — `packages/server/src/api/apiRoutes.ts`

- `GET /api/plans?overlordId=…` → `Plan[]` for one overlord, ordered by `createdAt` asc.
- `GET /api/plans?cwd=…` → `Plan[]` for one room (all overlords in that cwd).
- `GET /api/plans/:planId` → single plan.
- `POST /api/plans` body `{ overlordId, title, body }` — cwd is inferred from sessionStore lookup of overlordId. Returns the created plan.
- `PUT /api/plans/:planId` body `{ title?, body?, status? }` → patched plan or 404.
- `DELETE /api/plans/:planId` → `{ ok: true }` or 404.

All mutation endpoints broadcast `plan:changed` with `{ planId, overlordId, cwd, op: 'create'|'update'|'delete' }`.

#### Snapshot projection — `packages/server/src/session/stateManager.ts`

- `getSnapshot()` computes `session.planTasks` on-the-fly from `planStore.listByOverlord(overlordId)`:
  - Project each plan to the existing `Task` shape (`kind: 'plan'`, `status`, `summary: plan.title`, `planContent: plan.body`, `planToolUseId: plan.claudePlanToolUseId`, `createdAt`, `updatedAt`, `taskId: plan.planId`).
  - Sort by `createdAt` desc so the latest plan is first (matches existing WorkerPlanPill behavior).
- Wire shape unchanged; client needs no update for the pill to keep working.

### Client

#### Types — `packages/client/src/types.ts`

- Add `Plan` type mirroring server shape.
- Keep existing `Task` type unchanged (projection fills the gap).

#### New hook — `packages/client/src/hooks/usePlans.ts`

- `usePlans(overlordId)` → `{ plans: Plan[]; createPlan; updatePlan; deletePlan; isLoading }`.
- Fetches `GET /api/plans?overlordId=…` on mount; subscribes to `plan:changed` WS events and refetches on match.

#### New component — `packages/client/src/components/PlansTab.tsx`

- Rendered inside `DetailPanel` as a new subtab "Plans" (add to existing tab switcher).
- Layout: left column is plan list (title + status badge + relative time); right column is selected plan editor.
- Editor: title `<input>`, status `<select>` with the four statuses, body `<textarea>` rendered as markdown preview below (use existing markdown renderer from BrainTab if present, else plain monospace).
- "New plan" button at list top — creates with default title `"Plan"` and empty body, selects immediately.
- "Delete" button in editor — confirmation required.
- Saves debounce 500ms on input; explicit save on blur.
- `cwd` for a new plan is auto-derived from the overlord's session; not exposed in the form.

#### Room-level list — `packages/client/src/components/RoomDetailsTab.tsx`

- Add collapsible "Plans in this room" section listing plans from `GET /api/plans?cwd=…`.
- Each row: title, owning session (link), status, updatedAt.

#### Styling

- New `PlansTab.module.css` matching existing BrainTab visual language (Inter font, same badge colors).
- Status colors: draft=muted, active=blue, done=green, archived=gray.

#### UX rules

- If the Plans subtab is opened on a session with zero plans, show an empty state with a single "Create first plan" CTA.
- If the user edits a Claude-sourced plan's body, `source` stays `claude` and `updatedAt` refreshes. This preserves origin for history.
- Deleting a plan removes the file; cannot be undone via UI. Confirmation copy: "Delete plan \"{title}\"? This removes the file from overlord storage."

---

### Acceptance Criteria

**Server — PlanStore**
- [ ] `planStore.loadAll()` for `~/.claude/overlord/plans/` containing 3 valid `*.md` files returns a Map of size 3.
- [ ] A malformed frontmatter file is skipped and a warning is logged; loadAll does not throw.
- [ ] `planStore.create({...})` writes a file at `~/.claude/overlord/plans/{planId}.md` within 250ms of the call (debounced flush).
- [ ] File contents round-trip: `loadAll` after shutdown returns identical `Plan` objects for all fields.
- [ ] `planStore.patch(id, {title: 'x'})` updates `updatedAt` to within 1s of current time.
- [ ] Concurrent `patch(id, {title: 'a'})` + `patch(id, {body: 'b'})` in same tick produce a final file with both fields.
- [ ] `planStore.remove(id)` deletes the file and removes the in-memory entry.
- [ ] `planStore.upsertFromClaude({claudePlanToolUseId: 'X', ...})` called twice with same toolUseId results in exactly one file (second call patches first).
- [ ] External edit to a plan file (e.g. via editor) triggers re-parse within 200ms and a `plan:changed` WS broadcast.
- [ ] Writes are atomic — a reader mid-write never sees truncated content.

**Server — Migration**
- [ ] Seeded OverlordSession with 2 entries in `planTasks[]` produces 2 plan files under `~/.claude/overlord/plans/` and an OverlordSession with `planTasks` absent.
- [ ] Migrated plan files have `source='claude'` and `claudePlanToolUseId` matching the original `planToolUseId`.
- [ ] Status mapping: approved→active, rejected→archived, other→draft (verified via unit test with all three inputs).
- [ ] Re-running boot with marker present is a no-op (does not re-migrate).
- [ ] Migration failure (e.g. disk write error) does not write the marker; next boot retries.

**Server — Transcript integration**
- [ ] Parsing a transcript containing one `ExitPlanMode` tool_use produces exactly one plan file with `source='claude'`.
- [ ] Reparsing the same transcript does not create a duplicate plan file (idempotent by `claudePlanToolUseId`).
- [ ] `OverlordSession.planTasks` field is undefined in serialized JSON after this change (grep for `planTasks` in `~/.claude/overlord/overlord-sessions/*.json` returns no hits on fresh data).

**Server — API**
- [ ] `POST /api/plans` with valid body returns 200 and the created plan; the file exists on disk within 250ms.
- [ ] `POST /api/plans` with unknown `overlordId` returns 404.
- [ ] `PUT /api/plans/:planId` with `{status: 'done'}` updates the file and returns the updated plan.
- [ ] `DELETE /api/plans/:planId` removes the file; subsequent `GET` returns 404.
- [ ] `GET /api/plans?overlordId=...` returns only plans matching that overlord.
- [ ] `GET /api/plans?cwd=...` returns all plans in that room across overlords.
- [ ] Every mutation endpoint emits a `plan:changed` WS event observed by connected clients within 200ms.

**Server — Snapshot projection**
- [ ] `OfficeSnapshot.sessions[i].planTasks` is populated from plan files for each overlord and preserves the existing wire shape (Task type with `kind: 'plan'`, `planContent`, `planToolUseId`, etc.).
- [ ] WorkerPlanPill (existing UI) renders the latest plan's summary without code changes to the pill component.

**Client**
- [ ] "Plans" subtab appears in DetailPanel for every session.
- [ ] Creating a plan via the UI produces a file at `~/.claude/overlord/plans/{planId}.md`.
- [ ] Editing a plan's title and body in the UI updates the file within 1s.
- [ ] External edit to the plan file reflects in the UI within 500ms without refresh.
- [ ] Deleting a plan removes the file and the row from the list.
- [ ] Room-level "Plans in this room" section lists plans from all overlords in that cwd, sorted by `updatedAt` desc.
- [ ] Chrome DevTools MCP screenshot confirms the new tab matches BrainTab's visual language (spacing, typography, colors).

**Performance**
- [ ] `planStore.loadAll()` for 100 plan files completes in <150ms on a dev Mac.
- [ ] A single `patch()` call has p50 <0.5ms in-memory; flush latency is not observed by the caller.
- [ ] Client re-render on `plan:changed` event for a non-visible overlord does not cause the Plans tab to flicker.

---

### Out of scope

- Global cross-room "All plans" view — deferred; the `GET /api/plans` without filters is provided but no UI surface consumes it in v1.
- Plan versioning / history — plans are mutable in-place; git history serves as the audit trail.
- Exporting plans to external systems (Linear, GitHub issues) — later.
- Renaming a plan file to match its title slug — planId-named files are stable; display uses the title field.
- Moving a plan between overlords or cwds — delete + recreate.
- Permission checks on `~/.claude/overlord/plans/` directory — server trusts the filesystem; if writes fail, surface the error to the user.
- Conflict resolution when two clients edit the same plan simultaneously — last-write-wins via `updatedAt`; no CRDT.
- Exposing plans to git / repo artifacts — they live in central overlord storage, deliberately outside the repo.

### Open questions

1. Should the Plans tab replace or supplement the existing BrainTab plan-related UI? Suggest: supplement. BrainTab keeps its current scope; Plans tab is additive.
2. Should archived plans stay in the main directory or move under `~/.claude/overlord/plans/archive/`? Suggest: stay in place with `status='archived'` — simpler, single watcher.
3. Should the migration delete legacy `planTasks` arrays in-memory immediately or wait until the next natural OverlordSession write? Suggest: strip immediately via `sessionStore.patch` so disk state is consistent after boot.
4. Should `cwd` be stored as absolute or relative? Suggest: absolute, matching `OverlordSession.cwd`. A moved repo is already a broken state for the session record.
5. Should external file edits that set `status='archived'` also hide the plan from the Plans subtab by default? Suggest: yes — hide archived unless "Show archived" toggle is on.
6. Should plan files be grouped by overlordId into subdirectories (e.g. `plans/{overlordId}/{planId}.md`) instead of flat? Suggest: flat. Matches existing `overlord-sessions/` pattern and `listByOverlord` is an in-memory index lookup, not an `fs.readdir`.
