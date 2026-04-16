## Spec: sessionId revert detection + name preservation

**Goal:** Prevent two classes of anomalies that leave sessions in broken state:
1. A "resume loop" where a session's live `sessionId` reverts to a previous value (e.g., auto-compaction rebinds to the original transcript), and `transferSessionState` is run in reverse, producing: `resumedFrom` pointing forward in time, out-of-order `sessionHistory`, and a ghost interim entry that gets removed but leaves misleading traces.
2. A closed session losing its `proposedName` entirely (falls back to `sessionId.slice(0,8)` in the UI) because the PID file is gone and no other fallback reads the authoritative `customTitle` stored in the transcript header.

**Inputs / Triggers:**
- *Revert:* session file `{pid}.json` `changed` event where `raw.sessionId` matches a sid **already in the current ovrId's `sessionHistory`** (earlier than the current active sid), `raw.pid` matches the session's current PID, and `raw.startedAt` matches the current session's `startedAt` (same process, not a pid-reuse collision).
- *Name preservation:* `saveKnownSessions` writing an entry where `proposedName` is undefined, or `readProposedName` called for a closed session whose PID file is gone.

**Outputs / Side effects:**
- *Revert:* no new interim session entry is created; no `transferSessionState` runs in reverse; the existing active session for the ovrId is reverted to the prior sid with `resumedFrom`/`replacedBy` cleared for the reverted pair, and the interim sid is removed from `this.sessions`. SessionHistory remains chronological (no further mutation).
- *Name preservation:* `readProposedName` gains a new **Strategy 0** that reads the transcript's `customTitle` header line and strips `___OVR:` / `___BRG:` markers. `saveKnownSessions` calls the resolver once if `proposedName` is undefined, so closed-session entries always persist a name.

**Acceptance Criteria:**
- [ ] **Revert guard fires only on confirmed revert.** In `sessionEventHandlers.ts` `changed` handler, before calling `transferSessionState`, check: `(a)` raw.pid === oldSession.pid, `(b)` raw.startedAt === oldSession.startedAt, `(c)` oldSession.overlordId's `sessionHistory` contains an entry with `sessionId === raw.sessionId` whose `attachedAt < oldSession's current history entry`, `(d)` raw.sessionId is **not** in `deletedSessionIds`. If all hold, treat as revert.
- [ ] **Revert path takes a dedicated branch** — new method `revertToSid(interimSessionId, targetSessionId)` on StateManager that:
  - Promotes the existing `target` session entry back to active (clears `replacedBy`, restores `state` from raw).
  - Transfers live connection metadata (`bridgePipeName`, `bridgeMarker`, `ptySessionId`, `bridgeTty`) from interim → target.
  - Updates `sessionsByOvrId[ovrId] = targetSessionId`.
  - Removes `interimSessionId` from `this.sessions` (no lingering entry).
  - Does **not** mutate `target.resumedFrom` (keep whatever it was before the interim — typically `undefined` for the original, or an even-earlier sid for chains).
  - Does **not** re-merge `sessionHistory` — the history already contains both sids from the forward `transferSessionState`.
  - Calls `saveKnownSessions` + broadcasts `session:replaced` with `{oldSessionId: interim, newSessionId: target, ovrId}`.
- [ ] **Back-loop cleanup branch is removed.** `sessionEventHandlers.ts:296-297` (`if (oldSession.resumedFrom === raw.sessionId) remove(...)`) is deleted; the revert path replaces it.
- [ ] **`readProposedName` Strategy 0 reads transcript `customTitle`.** New first branch (before tasks dir and first-user-message) parses the first JSONL line; if `{"type":"custom-title","customTitle":"..."}`, strip `___OVR:.*` and `___BRG:.*` markers, return the result if non-empty. Cached in `proposedNameCache`.
- [ ] **`saveKnownSessions` preserves names for closed sessions.** When iterating sessions, if `s.proposedName` is undefined **and** `s.transcriptPath` is defined, call `readProposedName(s.sessionId, s.transcriptPath)` and persist the result (mutate `s.proposedName` in-memory so subsequent saves also carry it).
- [ ] **No regression on fresh spawn or legitimate /clear.** Unit tests cover: (1) fresh embedded PTY spawn → name preserved across close; (2) standard /clear creates forward chain with correct `resumedFrom`; (3) back-revert (A→B→A) leaves state identical to just A with no lingering B entry; (4) explicit `--resume` with historical sid + different PID is **not** treated as revert.
- [ ] **Log visibility.** New log events: `sid:revert` (with `{interim, target, ovrId}`) and `name:recovered-from-customtitle` (with `{sessionId, name}`) so the diagnose-sessions skill can verify the paths fire.

**Out of scope:**
- Fixing historical `known-sessions.json` entries already in the corrupted state (manual cleanup or one-time migration is a separate concern — this spec only prevents future occurrences).
- Changing how Claude Code itself assigns sids after /clear or compaction.
- Subagent transcripts (only top-level sessions have `customTitle`).
- UI changes — all fixes are server-side.

**Open questions:**
- When the revert target has `replacedBy` set pointing at an even-earlier interim that was already removed, should we also verify the chain is clean? Probably not — just trust `sessionsByOvrId` as source of truth and overwrite `replacedBy = undefined` on the reverted-to session.
- Should `readProposedName` Strategy 0 also try `slug` from transcript? Current order (customTitle → tasks dir → first user msg) captures the most-authoritative source first. Slug is less useful as a display name; skip for now.
