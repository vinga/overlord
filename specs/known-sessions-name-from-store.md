## Spec: Read proposedName from sessionStore (drop known-sessions duplicate)

**Goal:** Make `OverlordSession` (sessionStore) the single source of truth for `proposedName`, eliminating the silent rename-loss bug when the server exits ungracefully between a rename and the next `saveKnownSessions()` call.

**Placement:** _N/A_ (backend durability cleanup). No UI changes.

---

### Inputs / Triggers

- Server boot — `loadKnownSessions()` in `packages/server/src/session/stateManager.ts` populates the live `sessions` map.
- Rename API — `PUT /api/sessions/:sessionId/name` → `stateManager.setSessionName()` at `stateManager.ts:1899`.
- Any lifecycle event currently calling `saveKnownSessions()` (line 492, 795, 812, 985, 1053, 1069, 2000) and shutdown flush at `index.ts:1002`.

### Outputs / Side effects

- `known-sessions.json` no longer carries `proposedName` on newly written entries.
- `~/.claude/overlord/sessions/{ovrId}.json` (OverlordSession) remains the sole durable carrier of `proposedName`.
- Startup log line confirming how many sessions resolved `proposedName` via sessionStore vs. fallback.

---

### Server

#### Change 1 — `stateManager.saveKnownSessions()` (`stateManager.ts:426-463`)

- Remove the transcript backfill block at lines 432–441 (that logic belongs in sessionStore seeding, not in the legacy writer).
- Drop `proposedName: s.proposedName` from the serialized entry (line 452).

#### Change 2 — `stateManager.loadKnownSessions()` (`stateManager.ts:~280-370`)

Replace `proposedName: entry.proposedName` at line 335 with:

```ts
proposedName: sessionStore.getBySessionId(entry.sessionId)?.proposedName
          ?? entry.proposedName, // fallback: legacy entries not yet seeded into sessionStore
```

Rationale: sessionStore is the authoritative record; `entry.proposedName` remains as a one-boot fallback for pre-migration entries.

#### Change 3 — `stateManager.setSessionName()` (`stateManager.ts:1899-1914`)

No code change required. It already calls `sessionStore.patch(rec.overlordId, { proposedName: next })` which is now authoritative. Add a one-line comment noting that sessionStore is the durable write path; `known-sessions.json` no longer carries the name.

#### Change 4 — Migration / reconciliation at startup

In `loadKnownSessions()`, after the entry is pushed to `cleaned[]` and `this.sessions.set(...)`, reconcile drift between sessionStore and known-sessions:

- If `entry.proposedName` exists AND sessionStore has no `proposedName` for that ovrId → `sessionStore.patch(storedOvrId, { proposedName: entry.proposedName })` (initial seed).
- If `entry.proposedName` exists AND sessionStore has a *different* non-empty value → prefer `entry.proposedName` (known-sessions reflects the latest in-memory state including clone/clear/transcript paths that previously bypassed sessionStore). `sessionStore.patch(storedOvrId, { proposedName: entry.proposedName })`.
- If only sessionStore has a value → keep it.

Log once per boot: `[migration] reconciled N proposedName entries into sessionStore`.

After change 5 (drift fixes) lands, this reconciliation is a one-time healer; subsequent boots find no drift and log 0.

#### Change 5 — Close drift sites so sessionStore stays in sync

Three sites currently mutate `session.proposedName` in memory without patching sessionStore. Pair each with `sessionStore.patchBySessionId(sessionId, { proposedName })` (or `patch(ovrId, ...)` where ovrId is in scope):

- `packages/server/src/session/sessionEventHandlers.ts:70` — clone-info apply: `session.proposedName = info.name` → also patch sessionStore.
- `packages/server/src/session/stateManager.ts:948` — `transferSessionState` during /clear: `newSession.proposedName = oldSession.proposedName` → also patch sessionStore for `newSession.overlordId`.
- `packages/server/src/session/stateManager.ts:1339` — `updateFromTranscript`: `session.proposedName = proposedName` → patch sessionStore only when the value actually changes (compare against `existing.proposedName`).

### Client

_N/A_

---

### Acceptance Criteria

**Server**
- [ ] `known-sessions.json` written after any lifecycle event does NOT contain a `proposedName` key on any entry (verified by reading file after a rename + ack cycle).
- [ ] Renaming a session via `PUT /api/sessions/:sessionId/name`, then `kill -9` on the server (ungraceful exit), then restart → the renamed name is present on the live session after boot.
- [ ] Renaming a session, graceful SIGTERM restart → the renamed name is present on the live session after boot.
- [ ] On first boot after this change, entries where `entry.proposedName` is missing from or differs from `sessionStore.proposedName` are reconciled into sessionStore; a second boot shows zero reconciliations.
- [ ] Existing drifted session (`ovr-mmm8j49d`, named "Jade" in known-sessions, "ES BACKEND-2174 …" in sessionStore) is healed on first boot; session snapshot after boot carries `proposedName: "Jade"`.
- [ ] Each of the three drift sites (`sessionEventHandlers.ts:70`, `stateManager.ts:948`, `stateManager.ts:1339`) patches sessionStore after mutating `session.proposedName`.
- [ ] `packages/server/src/session/stateManager.ts` no longer references `readProposedName` inside `saveKnownSessions` (transcript backfill removed from this path).
- [ ] Existing unit test `sidRevert.test.ts` ("saveKnownSessions — backfills proposedName from transcript") is either deleted or moved to cover sessionStore seeding instead, whichever matches the new backfill location.

**Performance**
- [ ] No new disk reads per `saveKnownSessions()` call (backfill removed, so `readProposedName()` no longer fires per save).

---

### Out of scope

- Migrating other duplicated fields (`resumedFrom`, `bridgePipeName`, `bridgeMarker`, `transcriptPath`, `userAccepted`) out of `known-sessions.json`. Tracked separately.
- Full removal of `known-sessions.json` — it still carries cwd/pid/startedAt/sessionHistory for live-session bootstrap until the OverlordSession entity rollout fully supersedes it.
- Any client-side change. Wire format unchanged.

### Open questions

1. Should the one-time migration also clear `entry.proposedName` from the written file on that same boot, or leave it until the entry is next rewritten naturally? Suggest: leave it — entries are rewritten frequently, and leaving it avoids a special-case write path. The load-time fallback guarantees correctness even if the legacy value lingers.
2. If `sessionStore.getBySessionId(entry.sessionId)` returns no record at startup (sessionStore not yet seeded for that session), should we eagerly call `ensureFromLive` during load? Suggest: no — let the first natural `ensureFromLive` call (on snapshot, rename, notes edit, etc.) seed it. The legacy fallback covers the gap.
3. Does the deletion of the `sidRevert.test.ts` backfill test leave a coverage gap? Suggest: replace it with a sessionStore-level test that confirms `ensureFromLive` seeds `proposedName` from the live session's transcript-derived name, preserving the intent of the original test.
