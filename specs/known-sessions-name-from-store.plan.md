# Plan: Read proposedName from sessionStore (drop known-sessions duplicate)

Spec: `specs/known-sessions-name-from-store.md`

Order: Server → Verification. No Client section (spec is backend-only).

## Server

- [x] **S1** — In `packages/server/src/session/stateManager.ts` `loadKnownSessions()` (around line 335), resolve `proposedName` as `sessionStore.getBySessionId(entry.sessionId)?.proposedName ?? entry.proposedName`. Satisfies AC: "rename + kill -9 + restart" and "rename + SIGTERM restart".
- [x] **S2** — In the same `loadKnownSessions()` loop, after `this.sessions.set(...)`, reconcile drift: if `entry.proposedName` is non-empty AND differs from `sessionStore.getBySessionId(entry.sessionId)?.proposedName`, call `sessionStore.patch(storedOvrId, { proposedName: entry.proposedName })`. Track count; log once: `[migration] reconciled N proposedName entries into sessionStore`. Update S1's resolver to use the freshly reconciled value. Satisfies AC: "first boot reconciles; second boot reports zero" and "Jade healed on boot".
- [x] **S3** — In `saveKnownSessions()` (`stateManager.ts:426-463`), remove the transcript backfill block at lines 432–441 and drop `proposedName: s.proposedName` from the serialized entry (line 452). Satisfies AC: "written file does NOT contain `proposedName`", "no new disk reads per save", and "`saveKnownSessions` no longer calls `readProposedName`".
- [x] **S4** — In `setSessionName()` (`stateManager.ts:1899-1914`), add a one-line comment noting sessionStore is the durable write path. No behavior change.
- [x] **S5** — Remove or relocate the `sidRevert.test.ts` "saveKnownSessions — backfills proposedName from transcript" block (`packages/server/src/__tests__/sidRevert.test.ts:174+`). Satisfies AC: "test moved".
- [ ] **S6** — Close drift sites so sessionStore stays in sync going forward. Pair each mutation of `session.proposedName` with a `sessionStore.patchBySessionId(sessionId, { proposedName })` (or `patch(ovrId, ...)` where available):
  - `sessionEventHandlers.ts:70` — clone-info apply.
  - `stateManager.ts:948` — `transferSessionState` during /clear.
  - `stateManager.ts:1339` — `updateFromTranscript`, only when the value actually changes.
  Satisfies AC: "each of the three drift sites patches sessionStore".

## Verification

- [ ] **V1** — Walk acceptance criteria against the diff; confirm every AC has a corresponding change above.
- [ ] **V2** — Run server type-check (`npx tsc --noEmit -p packages/server/tsconfig.json`); confirm no compile errors.
- [ ] **V3** — Run the server test suite (`npx vitest run`); confirm no regressions.
- [ ] **V4** — Manual self-verify — backend only, no browser needed:
  1. Before restarting, note that `ovr-mmm8j49d` shows "Jade" in known-sessions and "ES BACKEND…" in sessionStore.
  2. Restart server, watch for `[migration] reconciled N proposedName entries into sessionStore`.
  3. After boot: `overlord-sessions/ovr-mmm8j49d.json` → `proposedName: "Jade"`.
  4. After boot: live snapshot carries `proposedName: "Jade"` for that session.
  5. Rename another session → `known-sessions.json` entry for it has no `proposedName`; sessionStore record has the new name.
  6. `kill -9`, restart → renamed name survives.
  7. Second restart: migration count = 0.
- [ ] **V5** — Grep for any remaining reads of `entry.proposedName` outside the fallback path and for writes of `proposedName` into `known-sessions.json`; confirm none remain.
