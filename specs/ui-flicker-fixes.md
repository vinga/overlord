## Spec: UI flicker fixes — permission-mode chip & state badge

**Goal:** Eliminate two intermittent flickers in the session header: (A) the permission-mode chip sometimes stays `AUTO-EDIT` after clicking to cycle to `PLAN`, and (B) the state badge briefly shows `THINKING` for ~1s when a session transitions `working → waiting`.

**Placement:** Server-side state logic + DetailPanel chip render. Chip: `packages/client/src/components/DetailPanel.tsx:2351`. State badge: server state computation in `packages/server/src/session/transcriptReader.ts` + `packages/server/src/session/stateManager.ts`.

---

### Inputs / Triggers

- **A (chip race):** User clicks the permission-mode chip in `DetailPanel` → `POST /api/sessions/:sessionId/cycle-permission-mode` → server injects `\x1b[Z` (shift+tab), waits 500ms, reads screen, calls `setPermissionMode`. Real-time `ptyEvents` / bridge data handler also call `setPermissionMode` independently.
- **B (thinking blink):** Any transcript idle period where file-modified age enters the 5–8s band between the last assistant/tool event and idle — `reEvalStateFromCache` returns `'thinking'` in that band regardless of whether Claude was actually mid-turn.

### Outputs / Side effects

- **A:** `session.permissionMode` updates monotonically to reflect the TUI's real mode. No path clobbers a confirmed mode with `'default'` or an older value.
- **B:** `session.state` does not pass through `'thinking'` when the true transition is `working → waiting` with no evidence of active computation.

---

### Server

#### A. Permission-mode chip

**File:** `packages/server/src/api/apiRoutes.ts` (lines 191–265)

1. Remove the `else newMode = 'default'` fallback at line 253. When `text` is non-empty but the `(shift+tab to cycle)` sentinel is not found, do NOT call `setPermissionMode`. The sentinel-absence case means the buffer tail was mid-repaint; real-time detection (`ptyEvents` / bridge handler) will set the correct mode when the next chunk lands.
2. Make the response return the session's *current* `permissionMode` after the 500ms settle — not a value derived only from this endpoint's screen read:
   ```ts
   res.json({ ok: true, mode: stateManager.getSession(sessionId)?.permissionMode });
   ```

**File:** `packages/server/src/session/stateManager.ts` (`setPermissionMode`, lines 1682–1695)

3. Respect the lock when transitioning to `'default'`: if `permissionModeLockedUntil` is in the future AND `mode === 'default'`, skip the write. Non-default writes still refresh the lock as today.
   ```ts
   setPermissionMode(sessionId: string, mode: string | undefined): void {
     const session = this.sessions.get(sessionId);
     if (!session) return;
     const locked = session.permissionModeLockedUntil != null
       && Date.now() < session.permissionModeLockedUntil;
     if (mode === 'default' && locked && session.permissionMode && session.permissionMode !== 'default') return;
     if (mode && mode !== 'default') {
       session.permissionModeLockedUntil = Date.now() + 15_000;
     }
     if (session.permissionMode !== mode) {
       session.permissionMode = mode;
       this.onChange();
     }
   }
   ```

#### B. Thinking blink

**File:** `packages/server/src/session/transcriptReader.ts` (`reEvalStateFromCache`, lines 87–118) and the main `readTranscriptState` branches (lines 820–872).

4. Introduce a narrower `'thinking'` rule. `'thinking'` should only be reported when there is positive evidence of active computation within the idle window:
   - `stateHint === 'codex_reasoning'` (unchanged — reasoning is explicit)
   - The last activity item in the feed is `kind: 'thinking'` (Claude emitted a reasoning block recently)
   - PTY/bridge spinner signal is active (`bridgeActiveOverride`) — this is already handled via `setBridgeActive`, so we don't need to produce `'thinking'` purely from age
5. Collapse the 5–8s intermediate band in `reEvalStateFromCache` and the main parse for the `tool_use`, `assistant_text`, `tool_result`, `user_input` hints: transition directly from `'working'` (ageSec < 5) to `'waiting'` (ageSec ≥ 5 for tool_use/assistant_text; ageSec ≥ 8 for tool_result/user_input, matching today's outer bound). `'thinking'` is only emitted by the evidence-based rule in step 4, not by age.
6. Keep `bridgeActive` override logic as-is (`stateManager.ts:618`) — it already promotes `'waiting'` → `'working'` when the TUI spinner is on.

> Out of scope in this fix: refactoring the state machine into a proper FSM. The goal here is to delete the unreliable middle band, not redesign the signal sources.

### Client

_N/A_ — no client rendering changes needed. The chip and state badge already re-render on snapshot.

---

### Acceptance Criteria

**Server**
- [ ] AC-A1: `POST /api/sessions/:sessionId/cycle-permission-mode` never calls `setPermissionMode(..., 'default')` when the screen text lacks the shift+tab sentinel.
- [ ] AC-A2: `setPermissionMode(id, 'default')` is a no-op while `permissionModeLockedUntil > now` AND current mode is non-default.
- [ ] AC-A3: After clicking the chip to cycle from `acceptEdits → plan`, `session.permissionMode === 'plan'` within 1s of the TUI status bar changing, in ≥10 consecutive clicks (manual verify).
- [ ] AC-B1: `reEvalStateFromCache` never returns `'thinking'` based solely on `ageSec` between 5 and 8 for `tool_use`, `assistant_text`, `tool_result`, or `user_input` hints.
- [ ] AC-B2: `readTranscriptState` returns `'thinking'` only when: (a) hint is `codex_reasoning` and ageSec < 6, OR (b) the most recent activity item has `kind: 'thinking'` and ageSec < 6.
- [ ] AC-B3: A session going from `working` to idle does not pass through `'thinking'` in the snapshot stream — states emitted are `working…working…waiting` (verified by logging snapshot state transitions across 20 turns).

**Performance**
- [ ] No new timers or intervals introduced; existing onChange debounce unchanged.

---

### Out of scope

- Rewriting modeDetect regex (works in common cases; future-proofing separate).
- Removing real-time `ptyEvents` mode detection (it's the correct source).
- Changing the 500ms settle wait in the cycle endpoint (kept for Windows `readScreen` correctness).
- Redesigning the state machine — only the fragile middle band is touched.

### Open questions

1. Should the cycle endpoint still attempt the 500ms screen-read at all, or just inject and let real-time paths update state? Suggest: keep the read (needed for Windows), but only apply its result when the sentinel is found — per step 1.
2. Should `'thinking'` be removed entirely as a state? Suggest: no — keep for the reasoning-evidence cases (codex reasoning, thinking blocks), just stop entering it from age-based inference.
3. Should we add a test fixture capturing raw `\x1b[Z` response bytes to exercise `modeDetect`? Suggest: yes, as a follow-up — not blocking this fix.
