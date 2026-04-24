# Global settings + query-worker hygiene

## Goal

1. Prevent internal query-worker sessions from ever appearing as rooms/workers in the office UI, and clean up orphan session files.
2. Add a global settings view (burger menu) with a toggle to disable all background LLM intent queries.

## Non-goals

- Per-session or per-room overrides.
- Multiple settings toggles beyond the background-LLM one (structure must allow extension; UI ships with one toggle).
- User accounts / remote sync.

## Part 1 — Query-worker hygiene

**Problem:** Query-worker sessions (from `runClaudeQuery()` in `packages/server/src/ai/claudeQuery.ts`) write `~/.claude/sessions/{pid}.json` via Claude's startup hook. `claudeQuery.ts` unlinks the file on process close, but:
- Orphan files from prior server runs / crashed queries persist.
- Even while alive they render as a `query-worker` room in the UI.

**Fix:**
1. `stateManager.getSnapshot()`: skip sessions whose `kind === 'query-worker'` (don't build a room for them).
2. On `SessionWatcher.start()` — or equivalent startup path in `packages/server/src/index.ts` — scan `~/.claude/sessions/*.json` and delete any whose `cwd` normalizes to `QUERY_WORKER_CWD` before emitting `added`.
3. Also sweep inside the existing periodic `cleanupStaleSessions()` tick.

## Part 2 — Global settings + burger menu

### Data model
`~/.claude/overlord/settings.json`:
```json
{ "disableBackgroundLLM": false }
```
Default when missing/invalid: `{ disableBackgroundLLM: false }`.

### Server
- New `packages/server/src/session/globalSettingsStore.ts`: `load()`, `get()`, `patch(partial)`, `onChange(cb)`. Writes atomically.
- REST:
  - `GET /api/settings` → current settings.
  - `PATCH /api/settings` (JSON body, partial) → merged settings.
- WebSocket: broadcast `{ type: 'settings', settings }` on change (via existing broadcast pipeline).
- `IntentSummarizer.maybeRefreshIntent()` early-returns when `disableBackgroundLLM` is true.
- When toggled on: call `killClaudeWorker()` to drain any queued/running query-worker process.

### Client
- Burger icon in office header (top-right).
- Click → modal overlay titled "Settings" with single toggle: **"Disable background AI intent queries"** + short helper text.
- `useGlobalSettings()` hook: reads settings from WS snapshot, `PATCH`es on change (optimistic).
- Styling: Linear/Raycast aesthetic per CLAUDE.md. Inter font, proper spacing.

## Acceptance criteria

### AC1 — Query-worker never renders
Trigger a background intent query; confirm no room/worker named `query-worker` appears in the office UI at any point.

### AC2 — Orphan files purged on startup
Place a fake `~/.claude/sessions/999999.json` with `cwd = ~/.claude/overlord/query-worker`. Start server. File is deleted; no session broadcast for it.

### AC3 — Settings persisted + broadcast
Toggle "Disable background AI intent queries" on. Reload page → toggle remains on. Open a second client → it reflects the change live without refresh.

### AC4 — Background LLM actually disabled
With toggle on, trigger conditions that would normally call `runClaudeQuery` via intent refresh. No `claude -p` spawns (verify via logs: no `[worker] new query` entry, no `[intent] … generating` entry).

### AC5 — Toggle off restores behavior
Toggle off; a subsequent intent-worthy transcript update produces a `[intent]` log line.

### AC6 — UI quality
Burger button visible but unobtrusive. Modal has clear title, one labeled toggle with description, close button, backdrop click closes. No console errors. Verified via Chrome DevTools MCP screenshot.
