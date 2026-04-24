# Plan: Global settings + query-worker hygiene

Derived from `specs/global-settings-query-worker.md`. Walk order: Server → Client → Verification.

## Server

- [ ] **S1. Purge orphan query-worker session files on startup** — in `packages/server/src/session/sessionWatcher.ts`, before enumerating existing files in `start()`, unlink any `*.json` whose parsed `cwd` normalizes to `QUERY_WORKER_CWD`. (AC2)
- [ ] **S2. Filter query-worker sessions from snapshot** — in `stateManager.getSnapshot()` (packages/server/src/session/stateManager.ts, ~line 1875), skip sessions where `session.kind === 'query-worker'` before room construction. Remove the now-dead sort special case (`aIsQW`/`bIsQW`). Add `kind` to persisted `Session` type if missing so the filter works. (AC1)
- [ ] **S3. Periodic sweep** — in `cleanupStaleSessions()` also unlink stale query-worker files on disk (not just in-memory sessions). (AC2)
- [ ] **S4. `globalSettingsStore.ts`** — new module at `packages/server/src/session/globalSettingsStore.ts`: load from `~/.claude/overlord/settings.json`, in-memory cache, `get()`, `patch(partial)`, `onChange(cb)`. Atomic write (tmp + rename). Default `{ disableBackgroundLLM: false }`.
- [ ] **S5. REST endpoints** — in `packages/server/src/api/apiRoutes.ts` add `GET /api/settings` and `PATCH /api/settings`. PATCH merges; returns full settings.
- [ ] **S6. WS broadcast on settings change** — in `packages/server/src/index.ts` (or wherever snapshot broadcasts live), subscribe to `globalSettingsStore.onChange` and push `{ type: 'settings', settings }` to all WS clients. Also include current settings in the initial snapshot message so clients don't need a separate fetch.
- [ ] **S7. Gate IntentSummarizer** — at the top of `maybeRefreshIntent()` and `tryGenerate()`, early-return when `globalSettingsStore.get().disableBackgroundLLM` is true.
- [ ] **S8. Drain on toggle-on** — in the onChange subscriber, when `disableBackgroundLLM` transitions false→true, call `killClaudeWorker()` from `claudeQuery.ts`.

## Client

- [ ] **C1. Types + WS handling** — add `GlobalSettings` type in `packages/client/src/types.ts`. Extend the snapshot message type with `settings`. Handle new `{ type: 'settings' }` message in the WS hook.
- [ ] **C2. `useGlobalSettings` hook** — new `packages/client/src/hooks/useGlobalSettings.ts`: reads settings from the snapshot/WS store, exposes `{ settings, update(partial) }`. `update` calls `PATCH /api/settings` optimistically.
- [ ] **C3. Burger button + SettingsModal** — new `packages/client/src/components/SettingsModal.tsx` (+ CSS module). Button in `Office.tsx` header (top-right). Modal: title "Settings", one toggle row "Disable background AI intent queries" with helper text ("Stops overlord from running Haiku queries to label sessions"), close button, backdrop-dismiss. Inter font, card styling consistent with existing panels.
- [ ] **C4. Wire toggle** — toggle bound to `settings.disableBackgroundLLM`, onChange calls `update({ disableBackgroundLLM: !current })`.

## Verification

- [ ] **V1. Walk acceptance criteria** — tick every AC from the spec against the implementation.
- [ ] **V2. Orphan purge smoke test** — drop a fake `~/.claude/sessions/999999.json` with cwd=QUERY_WORKER_CWD, restart server, confirm file is gone and no session appears in UI. (AC2)
- [ ] **V3. Settings persistence test** — toggle on via UI, kill+restart server, confirm toggle is still on and `~/.claude/overlord/settings.json` contains `{"disableBackgroundLLM":true}`. (AC3)
- [ ] **V4. LLM disabled test** — with toggle on, trigger a transcript update in any session; confirm server logs show no `[worker] new query` or `[intent] … generating` entries. Toggle off, trigger again, confirm log line appears. (AC4, AC5)
- [ ] **V5. Two-client sync** — open two browser tabs, toggle in one, verify the other updates live without reload. (AC3)
- [ ] **V6. UI polish screenshot** — open `http://localhost:5173`, click burger, screenshot modal via Chrome DevTools MCP, inspect spacing/typography, confirm no console errors. (AC6)
- [ ] **V7. No query-worker rooms** — force a background query (toggle off, make any session active), confirm no `query-worker` room or worker ever appears. (AC1)
