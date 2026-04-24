# CLAUDE.md

## Project

**Claude Office Monitor** — real-time visualization of Claude Code sessions as office workers in a 2D top-down view. Sessions are grouped into rooms by workspace (cwd). Subagents appear as smaller characters near their parent. Click a worker to open a detail panel.

## Higher Purpose & Design Standard

Provide a **truly beautiful, comfortable, at-a-glance useful** overview of active Claude sessions. Every UI decision must serve this goal.

**Never be lazy with the UI.** When making visual changes:
- Ask: does this look modern, clean, polished? (think Linear, Vercel, Raycast)
- Use Inter (sans-serif), not monospace, for readable text
- Use proper spacing, visual hierarchy, color contrast
- Take a screenshot via Chrome DevTools MCP and critically evaluate it
- If it looks dated or cluttered — fix it before moving on

## Commands

```bash
npm run dev                              # server + client
npm run dev --workspace=packages/server  # server only (port 3000, WS same)
npm run dev --workspace=packages/client  # client only (port 5173)
npm run build                            # production
```

## Architecture

```
packages/
├── server/   Node.js + TypeScript + Express + ws + chokidar
│   └── src/
│       ├── session/   session lifecycle, state, transcript watching
│       ├── pty/       terminal injection (PTY, bridge pipe, scheduling)
│       ├── ai/        classification, LLM queries, task storage
│       └── api/       REST routes + WebSocket handler
├── client/   React 18 + TypeScript + Vite + CSS Modules
│   └── src/
│       ├── hooks/      useOfficeData, useTerminal, useCustomNames, …
│       └── components/ Office, Room, Worker, DetailPanel, …
└── bridge/   Go binary — named-pipe relay for terminal injection
```

**Data flow:** `SessionWatcher` → `TranscriptReader` (jsonl tail) + `ProcessChecker` (PID poll) → `StateManager` → `OfficeSnapshot` broadcast via WebSocket → client renders office grid.

**Key files:**
- `server/src/session/stateManager.ts` — central state, snapshot broadcast
- `server/src/api/wsHandler.ts` — all WebSocket message handling
- `server/src/pty/injectScheduler.ts` — `scheduleInject()` / `shouldUseExtraEnter()`
- `client/src/components/DetailPanel.tsx` — chat UI, activity feed, terminal embed
- `client/src/hooks/useTerminal.ts` — PTY lifecycle hook

For deep dives, see `docs/`.

## Bridge Binary

Source: `packages/bridge/` (Go). Binary resolved via `getBridgePath()` in `packages/server/src/pty/pipeInjector.ts` → **`bridge/overlord-bridge`** at project root.

After any Go change:
```bash
cd packages/bridge && go build -o overlord-bridge . && cp overlord-bridge ../../bridge/overlord-bridge
```

## Session Matching Rules

**NEVER use CWD-based matching** — multiple sessions share the same CWD. Instead:
- **Name markers** in `--name` flags (e.g. `___OVR:ptyId`, `___BRG:marker`)
- **PID matching** when spawner knows child PID
- **sessionId matching** (e.g. `pendingPtyByResumeId`) when target sessionId is known

**Pending resume is marker-keyed**, not cwd-keyed (`stateManager.trackPendingResumeByMarker(ptyId, resumeSessionId)`). A cwd-keyed single-shot map loses the target on the second concurrent resume and breaks lineage linking. Both keys still exist — marker first, cwd fallback.

## /clear Detection

`/clear` creates new transcript + sessionId; PID stays the same; `{pid}.json` updates in-place. Detection uses **only PID-based mechanisms** (spec: `specs/clear-detection-simplification.md`):

1. **Live** (`sessionEventHandlers.ts`): `changed` event, PID matches, different sessionId → `transferSessionState()`
2. **Periodic** (`transcriptWatcher.ts`, 3s): stale transcript → re-read `{pid}.json`, detect mismatch
3. **Startup** (`stateManager.detectClearOnStartup()`): compare stored sessionId vs `{pid}.json` after watcher starts
4. **UI-injected** (`transcriptWatcher.ts`): explicit pending clear via `consumePendingClearReplacement()`

**Do NOT add** new /clear detection paths. CWD matching, transcript scanning, orphan scans, bridge marker suffix — all removed (raced and caused cascading bugs). Fix existing 3 paths instead.

## Lineage & Persistence

**Single source of truth for lineage-scoped fields = `OverlordSession` (one `{ovrId}.json`).**

- `color` lives on `OverlordSession.color`. No separate `colors.json`, no `colorOverrides` map. Read via `stateManager.sessionColorByOvrId(ovrId)`; write via `setSessionColor()` which calls `sessionStore.patch`.
- `proposedName`, `intent`, `gitBranch`, `sessionType` similarly canonical on OverlordSession; `Session.*` copies are derived at snapshot time.
- Don't add a second cache. `getSnapshot()` previously re-derived color every build — that band-aid was removed after the refactor.

**`OverlordSession.lastActivity` is NOT a freshness signal.** It's only seeded once on create and never updated. For "is this session alive", use the transcript file's mtime (`findTranscriptPath` + `fs.statSync`).

## Boot Hydration & Purge

- `hydrateAllActiveSessions()` loads every non-archived OverlordSession into `this.sessions` as closed on boot, so the user sees every room/session from disk without interacting first.
- `getSnapshot()` also surfaces configured rooms (`~/.claude/overlord/rooms/*.config.json`) even if zero sessions are hydrated for that cwd — via `listConfiguredRoomSlugs()` + reverse slug lookup through sessionStore.
- `purgeStaleOverlordSessionFiles()` runs 30s after boot, then daily. Deletes records whose transcripts are missing or older than 2 days — **but only when the ovrId is not hydrated into `this.sessions`**. Since boot hydrates every active record, nothing user-visible ever gets purged. Only truly orphaned records (hydration failed) drop. Do not revive cwd-keyed or `lastActivity`-based purges.

## Development: Plan Driven Development

Plans live in Overlord, not in `specs/` or `docs/sdd.md`. Manage them via the `overlord-plans` skill (REST to `/api/plans`).

**Flow:** draft plan → show full body inline in chat → user approves → set status `active` → implement → set status `done`. Never code before plan is approved. Always paste the full plan body in chat, not just a link or title.

## Browser Verification

After any client-side change, verify in browser via Chrome DevTools MCP (`http://localhost:5173`). Check console errors, layout, behavior. Fix issues before marking done.

## Independence & Self-Testing

Never ask the user to test something you can test yourself. Only ask when verification requires human judgment or physical interaction.

If port 5173 or 3000 is not running — start it with `npm run dev`. Do not ask.

## Agent Usage

Delegate to subagents as often as possible. Prefer parallel tool calls when independent.

## Guidelines

- **CLAUDE.md = index only.** Verbose stable content → `docs/`. Link from here.
- **One truth per rule.** Rule in global `~/.claude/CLAUDE.md` → not repeated here.
- **Concrete over vague.** Every constraint: number, path, or exact string.
- **Rules must be followed or removed.** A violated rule is noise.
- **Memory = surprises only.** Not what `git log` answers — non-obvious decisions only.
- **Platform-guard or remove.** OS-specific blocks must match `uname` or be deleted.

## Communication

⚠️ CRITICAL — EVERY RESPONSE, NO EXCEPTIONS:
- Short sentences only (3-6 words).
- No filler. Never start with "I'll", "Let me", "Sure", "Great".
- Tool first, result first. Explain only if asked.
- Pass to all subagents.
