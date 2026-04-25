# Boot Hydration, Purge, and PTY Liveness

## Boot Hydration & Purge

- `hydrateAllActiveSessions()` loads every non-archived OverlordSession into `this.sessions` as closed on boot, so the user sees every room/session from disk without interacting first.
- **No transcript gate on hydrate.** Every active OverlordSession record is hydrated on boot regardless of whether `findTranscriptPath` resolves. `/clear` (and other external tooling) can delete the lineage's current `.jsonl` out from under us; dropping the record would destroy linked artifacts (plans, colors, titles) with no recovery. `rehydrateFromSessionStore` tolerates a missing transcript. Since all records hydrate into `this.sessions`, the purge's "skip hydrated ovrIds" rule means nothing is auto-deleted.
- `getSnapshot()` also surfaces configured rooms (`~/.claude/overlord/rooms/*.config.json`) even if zero sessions are hydrated for that cwd — via `listConfiguredRoomSlugs()` + reverse slug lookup through sessionStore.
- `purgeStaleOverlordSessionFiles()` runs 30s after boot, then daily. Deletes records whose transcripts are missing or older than 2 days — **but only when the ovrId is not hydrated into `this.sessions`**. Since boot hydrates every active record with a transcript, only truly orphaned records (hydration failed) drop. Do not revive cwd-keyed or `lastActivity`-based purges.
- **`.tmp` sweep.** `sessionStore.loadAll()` unlinks any leftover `*.tmp` in `active/` and `archive/` dirs before loading — crashed `atomic-write` calls leave these behind and they get mistaken for live records by casual inspection.

## PTY Liveness in Snapshots

- `sessionType: 'embedded'` on `OverlordSession` is **persisted** and outlives a server restart, but the corresponding PTY (tracked only in the in-memory `ovrToPty` map in `index.ts`) does NOT. After restart, every embedded record is PTY-less until the user re-spawns one.
- Snapshots carry `Session.ptyAlive: boolean` for embedded sessions. It's stamped by `stateManager.setHasLivePtyFn(...)` which index.ts wires to `ovrToPty.get(ovrId) && ptyManager.has(ptyId)`. Use `ptyAlive` (server truth) over client-side `isPty` (only true after the current client opened a PTY) when gating "attached" UI.
- Injection guard: `wsHandler.ts` refuses `terminal:send` on embedded sessions with no live PTY — CGEvent can't reach a node-pty child, so the alternative is a misleading "Accessibility" error. Surfacing this as an error is correct; the client should display "Resume in new PTY" instead.
- **Orphaned `claude --resume` from prior boot.** A claude child from a previous server run holds the `~/.claude/sessions/{pid}.json` lock for its sessionId; reparented to launchd (ppid=1) after the server died. `terminal:resume` would otherwise fail with claude exiting immediately on lock collision. `findExistingClaudeResumePid` in `wsHandler.ts` classifies it as `killable` when ppid===server.pid OR the process command line carries our `___OVR:` / `___BRG:` marker — both cases are SIGTERM'd (escalating to SIGKILL after 2s) before respawning. Foreign claude processes without our marker are refused with an actionable kill-pid message.
