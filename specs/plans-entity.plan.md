# Plan: Plan entity — first-class, file-backed, overlord-scoped

Derived from `specs/plans-entity.md`. Walk: Server → Client → Verification.

---

## Server

- [ ] **S1. Define `Plan` / `PlanMeta` / `PlanStatus` / `PlanSource` types** in new file `packages/server/src/plans/types.ts`. Export from a barrel `packages/server/src/plans/index.ts`. — AC: *PlanStore — loadAll returns Plan objects*, *File contents round-trip*.

- [ ] **S2. Implement `PlanStore`** in `packages/server/src/plans/planStore.ts` with in-memory `Map<planId, Plan>`, secondary indexes (`overlordId → planId[]`, `cwd → planId[]`), debounced flush (200ms per planId), per-planId Promise-chain serialization, atomic tmp+rename write, `flushAll()` for SIGINT/SIGTERM. — AC: *loadAll size*, *patch updatedAt*, *concurrent patch merges*, *remove deletes*, *upsertFromClaude idempotent*, *atomic writes*, *flushAll on shutdown*.

- [ ] **S3. Frontmatter parser/serializer** in `packages/server/src/plans/frontmatter.ts`. Use `js-yaml` (check existing deps first; add if missing). Parse returns `{ meta: PlanMeta; body: string }`; serialize returns full file text. Reject files with missing required meta fields and log a warning. — AC: *malformed frontmatter skipped*, *round-trip identical*.

- [ ] **S4. Chokidar watcher on `~/.claude/overlord/plans/*.md`**, debounced 100ms per path, re-parse changed file, diff against in-memory entry, emit `plan:changed` if different. Ignore events triggered by own writes (tracked via an `ownWriteSuppress` set keyed on `{planId}.md`). — AC: *External edit triggers re-parse and broadcast*.

- [ ] **S5. Wire `PlanStore` lifecycle** into `packages/server/src/index.ts`: instantiate after `SessionStore`, call `loadAll()` at boot, register on shutdown. Pass to `stateManager`, `apiRoutes`, `transcriptReader`. — AC: *loadAll on boot*, *flushAll on shutdown*.

- [ ] **S6. Migration module** `packages/server/src/plans/migrateLegacyPlanTasks.ts`. Read marker `~/.claude/overlord/.plans-migration-v1-done`; if absent, iterate `sessionStore.list()`, convert each `planTasks[]` entry to a plan file, strip the field via `sessionStore.patch(overlordId, { planTasks: undefined })`. Write marker on success; abort without marker on any error. Status map: approved→active, rejected→archived, other→draft. — AC: *Seeded migration produces N plan files*, *source='claude' and claudePlanToolUseId preserved*, *status mapping*, *marker no-op*, *failure retries*.

- [ ] **S7. Transcript integration — rewrite `ExitPlanMode` branch** in `packages/server/src/session/transcriptReader.ts:676–690`. Stop mutating `planTasks` on the overlord. Call `planStore.upsertFromClaude({ overlordId, cwd, claudePlanToolUseId, body, status })` with status mapping from tool result. — AC: *one ExitPlanMode → one file*, *reparse idempotent*, *planTasks absent from new data*.

- [ ] **S8. Remove `planTasks` from `OverlordSession`** in `packages/server/src/types.ts:175–221` and from `packages/server/src/ai/taskStorage.ts` (delete `createPlanTask` caller sites that touch `planTasks`; keep the type only if still used for projection). Update session serialization. — AC: *planTasks grep returns zero hits*.

- [ ] **S9. Snapshot projection** in `packages/server/src/session/stateManager.ts`. `getSnapshot()` builds `session.planTasks` by calling `planStore.listByOverlord(overlordId)` and projecting to the existing `Task` shape: `{ taskId: plan.planId, kind: 'plan', status, summary: plan.title, planContent: plan.body, planToolUseId: plan.claudePlanToolUseId, createdAt, updatedAt }`. Sort by `createdAt` desc. — AC: *wire shape preserved*, *WorkerPlanPill unchanged*.

- [ ] **S10. REST endpoints** in `packages/server/src/api/apiRoutes.ts`:
  - `GET /api/plans?overlordId=…`
  - `GET /api/plans?cwd=…`
  - `GET /api/plans/:planId`
  - `POST /api/plans` — infer cwd via `sessionStore.get(overlordId).cwd`; 404 if overlord unknown.
  - `PUT /api/plans/:planId`
  - `DELETE /api/plans/:planId`
  Each mutation calls `broadcast({ type: 'plan:changed', planId, overlordId, cwd, op })`. — AC: *POST creates*, *POST 404 unknown overlord*, *PUT updates*, *DELETE removes*, *GET filters*, *plan:changed broadcast*.

- [ ] **S11. WebSocket broadcast** — add `plan:changed` handler in `packages/server/src/api/wsHandler.ts` (server-initiated broadcast helper; no inbound message required). — AC: *plan:changed observed within 200ms*.

## Client

- [ ] **C1. Add `Plan` type** to `packages/client/src/types.ts` mirroring server `PlanMeta + body`. Add `PlanChangedEvent`. — AC: *Plan type available to hook*.

- [ ] **C2. `usePlans(overlordId)` hook** in `packages/client/src/hooks/usePlans.ts`: initial fetch of `GET /api/plans?overlordId=…`, WS subscription filters `plan:changed` by `overlordId` and refetches. Expose `{ plans, createPlan, updatePlan, deletePlan, isLoading }`. — AC: *Tab updates without refresh*, *external edit reflects*.

- [ ] **C3. `usePlansByCwd(cwd)` hook** (thin variant of C2) for the Room view. — AC: *Room-level plans list*.

- [ ] **C4. `PlansTab` component** `packages/client/src/components/PlansTab.tsx` + `PlansTab.module.css`. Two-column layout: list left, editor right. Editor fields: title input, status select (draft/active/done/archived), body textarea + markdown preview. New plan button, Delete with confirmation. Debounce 500ms; save on blur. Empty state CTA. — AC: *subtab appears*, *create writes file*, *edit updates within 1s*, *delete removes row*, *BrainTab visual parity*.

- [ ] **C5. Integrate `PlansTab` into `DetailPanel`** `packages/client/src/components/DetailPanel.tsx`: add "Plans" entry to the existing tab switcher. — AC: *subtab appears for every session*.

- [ ] **C6. Room-level "Plans in this room" section** in `packages/client/src/components/RoomDetailsTab.tsx`: collapsible list using `usePlansByCwd`, rows show title / session link / status / updatedAt, sorted by `updatedAt` desc. — AC: *Room list sorted*.

- [ ] **C7. Markdown preview helper** — reuse the existing BrainTab renderer if present; otherwise render as `<pre>` with monospace. Track as a sub-decision, do not build a new renderer. — AC: *BrainTab visual parity*.

## Verification

- [ ] **V1. Walk acceptance criteria** — tick every AC in `specs/plans-entity.md §Acceptance Criteria`; for each, note the file + line where it is satisfied.

- [ ] **V2. Unit tests** in `packages/server/src/__tests__/planStore.test.ts`: round-trip, debounce merge, atomic write race, dedup by `claudePlanToolUseId`, loadAll on malformed file. — AC: *PlanStore group*.

- [ ] **V3. Migration fixture test** in `packages/server/src/__tests__/migrateLegacyPlanTasks.test.ts`: seed a temp `~/.claude/overlord/` with two `planTasks[]` entries, run migration, assert 2 `.md` files + stripped overlord JSON + marker present. — AC: *Migration group*.

- [ ] **V4. API smoke script** (ad-hoc `curl` via Bash): POST → GET → PUT → DELETE a plan against a live server, confirm 200s and file state. — AC: *API group*.

- [ ] **V5. Transcript integration test** — feed a synthetic transcript with one `ExitPlanMode` entry, assert one file created; feed twice, assert one file. — AC: *Transcript integration group*.

- [ ] **V6. Browser / self-verify** — `npm run dev`, open `http://localhost:5173`, Chrome DevTools MCP: (1) open a session's Plans tab, create a plan, confirm file exists via Bash `ls ~/.claude/overlord/plans/`. (2) edit title + body, confirm file updated. (3) edit the file externally, confirm UI refresh. (4) delete, confirm file gone. (5) screenshot matches BrainTab visual language. (6) no console errors. — AC: *Client group*.
