## Spec: Worker Intent Line

**Goal:** Replace the classifier-derived `requestSummary` line and the separate `completionSummary` line on worker cards with a single LLM-generated **intent line** describing what the session is currently working on.

**Placement:** Worker card, same slot currently occupied by `requestSummary` / `completionSummary` in `packages/client/src/components/Worker.tsx`. Plan pill and notes row are untouched.

---

### Inputs / Triggers

- Session transcript update event in `stateManager` (debounced 2s per session) → server calls `maybeRefreshIntent(sessionId, cwd)`.
- First observation of a session without a cached intent → lazy generation on first need.
- Session state transitions to `closed` → regeneration stops; last intent is frozen.

### Outputs / Side effects

- New `intent?: string` field on every session in the `OfficeSnapshot` broadcast via WebSocket.
- Haiku call via existing `runClaudeQuery` worker (queued, no new subprocess lifecycle).
- Persisted per session in `~/.claude/overlord/intent-summaries.json` (same style as `taskStorage.ts`); reloaded on startup.
- Worker card renders `intent` in place of `currentTask.title` and `completionSummaries[0].summary`.

---

### Server

**New module** `packages/server/src/ai/intentSummary.ts`

```ts
export interface IntentRecord {
  sessionId: string;
  intent: string;
  turnCount: number;   // user-turn count at time of generation
  updatedAt: number;
}

export function getIntent(sessionId: string): IntentRecord | null;
export function maybeRefreshIntent(sessionId: string, cwd: string): void;
```

**Refresh algorithm** (`maybeRefreshIntent`):
1. Read current transcript; count user turns.
2. Load cached `IntentRecord` from memory map.
3. If no cache → schedule generation.
4. If `(turnCount - cache.turnCount) >= 5` → schedule generation.
5. Otherwise → no-op.

**Generation:**
1. Extract last 5–8 user turns from transcript.
2. Truncate each turn to 500 chars; hard-cap total input at 3000 chars.
3. Call `runClaudeQuery(prompt, 20_000, validate)` using Haiku.
4. `validate` returns `false` if the session is closed or a fresher record has been stored since queueing.
5. Validate output: non-empty, ≤60 chars, no newlines. Reject otherwise — keep previous cached value.
6. Store record and broadcast updated snapshot.

**Prompt** (verbatim):

```
Summarize a Claude Code session for a dashboard card.

Output: ONE short phrase, 3-8 words, no period.
Style: noun phrase or gerund. Present tense.
Examples:
  "Refactoring Brain tab to room level"
  "Debugging WebSocket reconnect loop"
  "Adding PR badge to room header"

Rules:
- No preamble, no quotes, no explanation.
- If work pivoted, describe the most recent thread.
- If unclear, output: "Exploring codebase".

User messages (most recent last):
<turns>
```

**Integration:** `packages/server/src/session/stateManager.ts` calls `maybeRefreshIntent(sessionId, cwd)` on transcript-update events (debounced 2s per session). Closed sessions are skipped. Snapshot serialization includes `intent` on each `SessionSnapshot`.

**Persistence:** JSON file at `~/.claude/overlord/intent-summaries.json`, keyed by `sessionId`. Loaded synchronously on server startup; saved after each successful generation.

### Client

**Types:** extend `Session` in `packages/client/src/types.ts` with `intent?: string`. Pass through `Worker` props.

**Render changes** in `packages/client/src/components/Worker.tsx`:
- Remove the `requestSummary` line (`currentTask?.title` + `completionHint !== 'done'`).
- Remove the `completionSummary` line (`completionSummaries[0].summary` + `completionHint === 'done'`).
- Add a single `intent` line in the same slot.
  - Active session → normal text style (reuse `requestSummary` class).
  - Closed session → muted color + subtle checkmark prefix (new `intentDone` modifier class).
- If `intent` is absent → render nothing (no fallback text, no skeleton).

**Unchanged:** notes row, plan pill, Tasks tab (classifier still drives Tasks-tab records).

**Styling:** extend `Worker.module.css` with `.intentDone` (muted color, `✓ ` prefix via `::before`). No animations.

---

### Acceptance Criteria

**Server**
- [ ] `intent` field appears on every `SessionSnapshot` in WebSocket and `/api/office` payloads.
- [ ] First Haiku call fires only when a session is observed without a cached intent.
- [ ] Subsequent calls fire only after ≥5 new user turns since last generation.
- [ ] Closed sessions never trigger regeneration.
- [ ] Output is rejected (cached value kept) when empty, >60 chars, or containing newlines.
- [ ] Intent records survive server restart via `~/.claude/overlord/intent-summaries.json`.
- [ ] Debounce prevents more than one generation per session within a 2-second window.
- [ ] Classifier (`aiClassifier.ts`) still runs unchanged for Tasks-tab records.

**Client**
- [ ] Worker card shows `intent` in the slot previously used by `requestSummary` / `completionSummary`.
- [ ] Active sessions render intent in normal style; closed sessions render muted with `✓` prefix.
- [ ] When `intent` is missing, the slot renders nothing.
- [ ] Plan pill and notes row render identically to before.
- [ ] Tasks tab still lists classifier-driven task records.
- [ ] No console errors on session update or tab switch.

**Performance**
- [ ] Haiku call latency <3s p50; card renders without intent until it arrives.
- [ ] Total daily LLM cost stays under $1 at Haiku pricing for 200 active sessions.
- [ ] Generation queued through existing `runClaudeQuery` worker — no new subprocess lifecycle introduced.

---

### Out of scope

- Manual editing / overriding of the intent from the UI.
- Per-session prompt customization or multi-language prompts.
- Intent generation for subagents (parent sessions only in v1).
- Historical intent timeline / change log.
- Retiring the classifier entirely (Tasks tab continues to use it).

### Open questions

1. **Regeneration cadence.** `N=5` user turns is a guess. Should it adapt — fewer turns for short bursts, more for long explorations? Suggest: keep static `N=5` for v1, revisit after a week of usage data.
2. **Subagent intent.** Generate for subagents too, or inherit parent? Suggest: skip subagents in v1 — cards are smaller and already show a task label.
3. **Closed-session style.** Muted + `✓` prefix proposed — keep, or use identical styling to active? Suggest: muted + `✓` — makes done state scannable at a glance.
4. **Classifier coexistence.** Any future overlap where classifier could retire? Suggest: defer — keep both after v1, evaluate once intent line is in production for a week.
