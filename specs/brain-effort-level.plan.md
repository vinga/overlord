# Plan: Effort level in Brain tab

Derived from `specs/brain-effort-level.md`. Walk order: Server → Client → Verification.

## Server

- [ ] **S1. Add `BrainEffort` types and extend `BrainContext`** — in `packages/server/src/brain/brainContext.ts`, add `EffortValue` + `BrainEffort` interfaces and add `effort: BrainEffort` to `BrainContext`. (AC: response shape includes `effort: { global, project, effective }`.)
- [ ] **S2. Implement `extractEffort(settings, home, cwd)`** — walk `SettingsWithSource[]`, classify by path (home = global; `<cwd>/.claude/settings.json` and `settings.local.json` = project, local wins), read `data.effortLevel` if string, compute `effective = project.value ?? global.value ?? null`. (AC: global-only → global="xhigh"/project=null/effective="xhigh"; project override → project wins.)
- [ ] **S3. Wire into `getBrainContext`** — call `extractEffort` and include in returned object. No cache-invalidation changes (settings paths already tracked by existing source list). (AC: touching `~/.claude/settings.json` invalidates within existing TTL; no change to other brain fields.)

## Client

- [ ] **C1. Mirror types in `BrainTab.tsx`** — add `BrainEffort` interface and `effort: BrainEffort` to local `BrainContext`.
- [ ] **C2. Extend card state** — add `'effort'` to `CardKey` union; set `DEFAULT_OPEN.effort = true`. (AC: card open/closed state persists via existing `brainTab:<cwd>:cards` key.)
- [ ] **C3. Render Effort card** — between Identity and Memory. Effective value as prominent chip at top; `Global` and `Project` rows with value pill or `—` and muted source path; dim Global row when project override exists; show "No effort level configured" caption when effective is null. (AC: chip matches `effort.effective`; no override → Project `—` muted; override → Global dimmed.)
- [ ] **C4. Add minimal styles** — only if existing card classes don't cover chip + row; add `.effortChip` and `.effortRow` to `BrainTab.module.css`. Reuse permission-mode chip styling for consistency. (AC: layout stable under 400px.)

## Verification

- [ ] **V1. Walk acceptance criteria** — tick every server + client + performance criterion from the spec against the implementation.
- [ ] **V2. Server smoke test** — `curl http://localhost:3000/api/brain?cwd=<overlord-path>` and assert `.effort.global.value === "xhigh"`, `.effort.effective === "xhigh"`.
- [ ] **V3. Project override test** — temporarily write `packages/server/.claude/settings.json` with `{"effortLevel":"medium"}`, refetch, confirm `project.value === "medium"` and `effective === "medium"`; remove the file.
- [ ] **V4. Browser / self-verify** — open `http://localhost:5173`, open Brain tab on any room, screenshot via Chrome DevTools MCP, confirm Effort card renders, chip value matches, card persists open/closed across page reload, no console errors.
