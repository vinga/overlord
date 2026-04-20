# Plan: UI flicker fixes

Derived from `specs/ui-flicker-fixes.md`. Walk: Server → Verification (no client changes).

## Server

### A. Permission-mode chip

- [ ] **S1** — In `packages/server/src/api/apiRoutes.ts:248-254`, drop `else newMode = 'default'`. Only set `newMode` when `sentinelFound && mode`. _(AC-A1)_
- [ ] **S2** — In `packages/server/src/api/apiRoutes.ts:260`, return `mode: stateManager.getSession(sessionId)?.permissionMode`. _(AC-A1)_
- [ ] **S3** — In `packages/server/src/session/stateManager.ts:1682-1695`, guard `setPermissionMode`: if `mode === 'default'` and lock is active and current mode is non-default, return early. _(AC-A2)_

### B. Thinking blink

- [ ] **S4** — In `packages/server/src/session/transcriptReader.ts:97-117` (`reEvalStateFromCache`), collapse middle band:
  - `tool_use`: `ageSec < 5 ? 'working' : 'waiting'` (drop thinking), keep `needsPermission` at ageSec > 8.
  - `assistant_text`: `ageSec < 5 ? 'working' : 'waiting'`.
  - `tool_result` / `user_input`: `ageSec < 8 ? 'working' : 'waiting'` (drop thinking).
  - `codex_reasoning`: unchanged.
  _(AC-B1)_
- [ ] **S5** — In `packages/server/src/session/transcriptReader.ts:820-872` (main parse), mirror S4:
  - `tool_use` MCP/long-running branch (line 834): `ageSec < 8 ? 'working' : 'waiting'`.
  - `tool_use` standard (lines 835-842): keep ageSec<5 working, ageSec>8 waiting+needsPermission, else ageSec 5–8 → `'waiting'`.
  - `assistant_text` (line 846): `ageSec < 5 ? 'working' : 'waiting'`.
  - `tool_result` (line 864) / `user_input` (line 867): `ageSec < 8 ? 'working' : 'waiting'`.
  _(AC-B1, AC-B3)_
- [ ] **S6** — Add evidence-based `'thinking'` in main parse: after computing state, if state would be `'waiting'` or `'working'`, override to `'thinking'` when the most recent activity item is `kind: 'thinking'` AND `ageSec < 6`. Keep `codex_reasoning` case as-is. _(AC-B2)_

## Verification

- [ ] **V1** — `npm run build --workspace=packages/server` passes with no TypeScript errors.
- [ ] **V2** — Walk acceptance criteria AC-A1…A3, AC-B1…B3 in the edited files, confirm each is satisfied.
- [ ] **V3** — Browser / self-verify: restart server, open `http://localhost:5173`, click permission-mode chip on a running session 5× (acceptEdits → plan → default → acceptEdits → plan), confirm chip updates each time within ~1s. Observe state badge across 3 turns of a live session, confirm no brief `'thinking'` flash on `working → waiting` transitions. Report findings.
