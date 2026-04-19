# Plan: Worker Intent Line

Derived from `specs/intent-line.md`. Execute in order. Each step maps to one or more acceptance criteria.

## Server

- [ ] **1. Create `packages/server/src/ai/intentSummary.ts`** — `IntentRecord`, `getIntent`, `maybeRefreshIntent`. Refresh algorithm: count user turns, compare to cached `turnCount`, schedule generation if missing or ≥5 new turns.
  - AC: "First Haiku call fires only when a session is observed without a cached intent"
  - AC: "Subsequent calls fire only after ≥5 new user turns"

- [ ] **2. Implement Haiku generation with validation** — extract last 5–8 user turns, truncate 500 chars / cap 3000 total, call `runClaudeQuery` with verbatim spec prompt, 20s timeout, `validate` callback. Reject empty / >60 chars / newlines — keep previous value.
  - AC: "Output is rejected (cached value kept) when empty, >60 chars, or containing newlines"

- [ ] **3. Add persistence to `~/.claude/overlord/intent-summaries.json`** — load on startup, save after each successful generation.
  - AC: "Intent records survive server restart"

- [ ] **4. Wire into `packages/server/src/session/stateManager.ts`** — transcript-update events call `maybeRefreshIntent(sessionId, cwd)` with 2s per-session debounce. Skip closed. Add `intent` to `SessionSnapshot` serialization.
  - AC: "intent field appears on every SessionSnapshot"
  - AC: "Closed sessions never trigger regeneration"
  - AC: "Debounce prevents more than one generation per session within a 2-second window"

## Client

- [ ] **5. Extend client types** — `intent?: string` on `Session` in `packages/client/src/types.ts`; thread through `Worker` props.

- [ ] **6. Replace `requestSummary` / `completionSummary` with intent line** in `packages/client/src/components/Worker.tsx` — remove both lines, render single `intent` line; active = normal style, closed = muted + ✓ prefix. Missing intent → nothing.
  - AC: "Worker card shows intent in the slot previously used by requestSummary / completionSummary"
  - AC: "Active sessions render intent in normal style; closed sessions render muted with ✓ prefix"
  - AC: "When intent is missing, the slot renders nothing"
  - AC: "Plan pill and notes row render identically to before"

- [ ] **7. Add `.intentDone` style** in `packages/client/src/components/Worker.module.css` — muted color, `✓ ` prefix via `::before`, no animation.

## Verification

- [ ] **8. Walk every checkbox in `specs/intent-line.md` §Acceptance Criteria** — Server, Client, Performance. Note how each was verified; flag any that cannot be.

- [ ] **9. Self-verify in browser** — at `http://localhost:5173`, restart server if needed, click into room, observe worker cards. Confirm intent renders in place of old lines; active vs closed styling; missing intent renders nothing; no console errors. Hit `/api/office` and confirm `intent` on sessions.

## Execution notes

- Classifier in `aiClassifier.ts` stays untouched — still drives Tasks tab records.
- Subagents skipped in v1.
- Haiku calls queued through existing `runClaudeQuery` worker — no new subprocess lifecycle.
