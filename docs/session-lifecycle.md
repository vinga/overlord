# Session Lifecycle: Lineage, Hydration, PTY Liveness

## Lineage & Persistence

**Single source of truth for lineage-scoped fields = `OverlordSession` (one `{ovrId}.json`).**

- `color` lives on `OverlordSession.color`. No separate `colors.json`, no `colorOverrides` map. Read via `stateManager.sessionColorByOvrId(ovrId)`; write via `setSessionColor()` which calls `sessionStore.patch`.
- `proposedName`, `intent`, `gitBranch`, `sessionType` similarly canonical on OverlordSession; `Session.*` copies are derived at snapshot time.
- Don't add a second cache. `getSnapshot()` previously re-derived color every build — that band-aid was removed after the refactor.

**`OverlordSession.lastActivity` is NOT a freshness signal.** Seeded once on create, never updated. For "is this session alive", use the transcript file's mtime (`findTranscriptPath` + `fs.statSync`).

**Transcript shadow store.** Claude externally deletes `.jsonl` files (notably after `/clear`). Every transcript Overlord observes is hard-linked into `~/.claude/overlord/transcripts/<ovrId>/<sid>.jsonl` via `ensureShadow()` in `transcriptShadow.ts`. Hard links share the inode, so when Claude unlinks the canonical path the data stays alive under our shadow until `sessionStore.remove(ovrId)` calls `removeShadowDir`. `findTranscriptPath` / `findTranscriptPathAnywhere` fall back to the shadow lookup (sid → ovrId via `sessionStore.getBySessionId`). Link points: `attachSession`, `ensureFromLive`, `rehydrateFromSessionStore`, plus a boot backfill loop in `hydrateAllActiveSessions`.

## Boot Hydration & Purge

- `hydrateAllActiveSessions()` loads every non-archived OverlordSession into `this.sessions` as closed on boot, so the user sees every room/session from disk without interacting first.
- **No transcript gate on hydrate.** Every active OverlordSession record is hydrated on boot regardless of whether `findTranscriptPath` resolves. `/clear` (and other external tooling) can delete the lineage's current `.jsonl` out from under us; dropping the record would destroy linked artifacts (plans, colors, titles) with no recovery. `rehydrateFromSessionStore` tolerates a missing transcript. Since all records hydrate into `this.sessions`, the purge's "skip hydrated ovrIds" rule means nothing is auto-deleted.
- `getSnapshot()` also surfaces configured rooms (`~/.claude/overlord/rooms/*.config.json`) even if zero sessions are hydrated for that cwd — via `listConfiguredRoomSlugs()` + reverse slug lookup through sessionStore.
- `purgeStaleOverlordSessionFiles()` runs 30s after boot, then daily. Deletes records whose transcripts are missing or older than 2 days — **but only when the ovrId is not hydrated into `this.sessions`**. Since boot hydrates every active record with a transcript, only truly orphaned records (hydration failed) drop. Do not revive cwd-keyed or `lastActivity`-based purges.
- **`.tmp` sweep.** `sessionStore.loadAll()` unlinks any leftover `*.tmp` in `active/` and `archive/` dirs before loading — crashed `atomic-write` calls leave these behind and they get mistaken for live records by casual inspection.

## PTY Liveness in Snapshots

- `sessionType: 'embedded'` on `OverlordSession` is **persisted** and outlives a server restart, but the corresponding PTY (tracked only in the in-memory `ovrToPty` map in `index.ts`) does NOT. After restart, every embedded record is PTY-less until the user re-spawns one.
- Snapshots carry `Session.ptyAlive: boolean` for embedded sessions. Stamped by `stateManager.setHasLivePtyFn(...)` which `index.ts` wires to `ovrToPty.get(ovrId) && ptyManager.has(ptyId)`. Use `ptyAlive` (server truth) over client-side `isPty` (only true after the current client opened a PTY) when gating "attached" UI.
- Injection guard: `wsHandler.ts` refuses `terminal:send` on embedded sessions with no live PTY — CGEvent can't reach a node-pty child, so the alternative is a misleading "Accessibility" error. Surfacing this as an error is correct; the client should display "Resume in new PTY" instead.
- **Orphaned `claude --resume` from prior boot.** A claude child from a previous server run holds the `~/.claude/sessions/{pid}.json` lock for its sessionId; reparented to launchd (ppid=1) after the server died. `terminal:resume` would otherwise fail with claude exiting immediately on lock collision. `findExistingClaudeResumePid` in `wsHandler.ts` classifies it as `killable` when ppid===server.pid OR the process command line carries our `___OVR:` / `___BRG:` marker — both cases are SIGTERM'd (escalating to SIGKILL after 2s) before respawning. Foreign claude processes without our marker are refused with an actionable kill-pid message.

## Auto-Resume After Restart

Gated on `autoResumeOnRestart` (settings) or `OVERLORD_AUTO_RESUME=1`; fired once on the first client WebSocket connection (`wsHandler.ts`), not at boot, so the user is connected to receive the resumed terminals' output. `autoResumePtySessions` only resumes sessions named by a **live-set record** — `getPtySessionsToResume()` alone returns every closed embedded session ever, which would spawn a claude per stale card. Two records exist, both under `~/.claude/overlord/`:

1. **`live-at-shutdown.json`** — written by `shutdown()` (SIGTERM / SIGINT / **SIGHUP**) as the *first* step, before any `await`. The flushes that follow can be out-raced by a logout/restart grace period, and a lost capture means nothing resumes. Consumed once at boot (`index.ts`), then deleted.
2. **`live-pty.json`** — a 15s write-on-change heartbeat mirror of `ovrToPty` (+ each PTY child's pid). Covers the deaths where `shutdown()` never runs: computer restart, panic, `kill -9`. Only consulted when record 1 is absent, and only trusted when **all three** guards in `consumeLivePtyFallback()` pass: non-empty entries; younger than 24h; and either written before the current OS boot (`mtime < now - os.uptime()`, so every child it names is gone) or every recorded pid is dead. A rejected heartbeat is still consumed, so it can't be retried next boot.

A clean shutdown deletes the heartbeat — record 1 wins whenever it exists. Node's default action for SIGHUP is instant death; **do not remove the SIGHUP handler**, it is the whole reason a computer restart resumes at all (a closing terminal hangs up the controlling tty).

## /clear Detection

`/clear` creates new transcript + sessionId; PID stays the same; `{pid}.json` updates in-place. Detection uses **only PID-based mechanisms** (spec: `specs/clear-detection-simplification.md`):

1. **Live** (`sessionEventHandlers.ts`): `changed` event, PID matches, different sessionId → `transferSessionState()`
2. **Periodic** (`transcriptWatcher.ts`, 3s): stale transcript → re-read `{pid}.json`, detect mismatch
3. **Startup** (`stateManager.detectClearOnStartup()`): compare stored sessionId vs `{pid}.json` after watcher starts
4. **UI-injected** (`transcriptWatcher.ts`): explicit pending clear via `consumePendingClearReplacement()`

**Do NOT add** new /clear detection paths. CWD matching, transcript scanning, orphan scans, bridge marker suffix — all removed (raced and caused cascading bugs). Fix existing 4 paths instead.
