# CLAUDE.md

## Project

**Claude Office Monitor** — real-time visualization of Claude Code sessions as office workers in a 2D top-down view. Sessions grouped into rooms by workspace (cwd). Subagents appear as smaller characters near their parent. Click a worker to open a detail panel.

## UI Standard

Target: Linear / Vercel / Raycast polish. Inter (sans-serif), not monospace, for readable text. Proper spacing, hierarchy, contrast. After any client change: screenshot via Chrome DevTools MCP at `http://localhost:5173`, evaluate, fix before declaring done.

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
│   └── src/{session,pty,ai,api}/
├── client/   React 18 + TypeScript + Vite + CSS Modules
│   └── src/{hooks,components}/
└── bridge/   Go binary — named-pipe relay for terminal injection
```

**Data flow:** `SessionWatcher` → `TranscriptReader` (jsonl tail) + `ProcessChecker` (PID poll) → `StateManager` → `OfficeSnapshot` broadcast via WebSocket → client renders office grid.

**Key files:**
- `server/src/session/stateManager.ts` — central state, snapshot broadcast
- `server/src/api/wsHandler.ts` — all WebSocket message handling
- `server/src/pty/injectScheduler.ts` — `scheduleInject()` / `shouldUseExtraEnter()`
- `client/src/components/DetailPanel.tsx` — chat UI, activity feed, terminal embed
- `client/src/hooks/useTerminal.ts` — PTY lifecycle hook

Deep dives: `docs/architecture.md`, `docs/session-lifecycle.md`.

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

**Pending resume is marker-keyed**, not cwd-keyed (`stateManager.trackPendingResumeByMarker(ptyId, resumeSessionId)`). Cwd-keyed loses the target on the second concurrent resume. Both keys still exist — marker first, cwd fallback.

## Session Lifecycle

See `docs/session-lifecycle.md` for lineage/persistence, boot hydration & purge, PTY liveness, /clear detection. Highlights:

- `OverlordSession` is the single source of truth for `color`, `proposedName`, `intent`, `gitBranch`, `sessionType`. No second cache.
- `OverlordSession.lastActivity` is seed-only — use transcript mtime for freshness.
- Boot hydrates every active record into `this.sessions` (no transcript gate). Purge skips hydrated ovrIds.
- `Session.ptyAlive` (server truth) > client-side `isPty` for "attached" UI.
- /clear detection: 4 PID-based paths only. Do NOT add new ones.

## Plan-Driven Development

Manage plans via the `overlord-plans` skill (REST to `/api/plans`). Flow: draft → paste full body in chat → user approves → status `active` → implement → status `done`. Never code before approval. Paste the full plan body, not a link.

**Required when:** refactor touches > 2 files, any persistence or schema change, any auto-scheduled job, anything user-visible after restart. Small single-file bug fixes: skip the plan.

## Independence & Self-Testing

Never ask the user to test something you can test yourself. Only ask when verification requires human judgment. If port 5173 or 3000 is not running — start it with `npm run dev`. Do not ask.

## Agent Usage

Delegate to subagents whenever independent work parallelizes. Prefer parallel tool calls.

## Destructive Operations

- File deletions (`fs.unlinkSync`, `sessionStore.remove`, `rm -rf`): if count > 5 OR touches `~/.claude/overlord/overlord-sessions/` AND count > 0, dry-run first and print the list before deleting. Wait for explicit user approval.
- Auto-jobs that delete data must default to OFF. Enable via explicit toggle (env var, settings flag, or CLAUDE.md-documented manual invocation). No `setTimeout(destructiveFn, 30s)` on boot.
- Cross-check freshness against a second source (transcript mtime, not `lastActivity`).

## Background Jobs (env toggles)

- `OVERLORD_ARCHIVE_PR_REFRESH` (default ON; set `0`/`false` to disable): hourly REST refresh of PR state for archived/closed rooms only, non-MERGED entries only. Live rooms already poll on the 15-min TTL. Non-destructive (records into `prHistoryStore`); kill switch exists for perf-sensitive machines. See `stateManager.refreshArchivedPrs` / `selectArchivedPrTargets`.

## Interrupts

When the user sends a message mid-tool-call, finish the in-flight call only if it's a read. For writes/destructive actions, stop, re-read the latest user message, confirm before continuing.

## Options & Restarts

- When the user picks an option by number/letter, implement THAT option. If you deviate, say so before coding.
- Server code changes (`packages/server/**`) do NOT hot-reload — `tsx watch` was removed. After editing any `packages/server/**` file, invoke the `restart-server` skill yourself before asking the user to verify. Do not tell the user to restart manually unless they opted out. Do not claim a server feature "works" until restart returns `server:200`.
- Before editing any file that shows a `<system-reminder>` "was modified" notice, re-read it.

## React Render Hygiene

New derived arrays/objects in render bodies of `DetailPanel.tsx`, `Office.tsx`, `Room.tsx` must be `useMemo`'d on the underlying snapshot reference. These re-render every WebSocket tick; an unmemoized `.filter()` / `.map()` breaks downstream memoization and the UI stutters. If the transform is a no-op in the common case, preflight-scan and return the original reference.

## Guidelines

- **CLAUDE.md = index only.** Verbose stable content → `docs/`. Link from here.
- **One truth per rule.** Rule in global `~/.claude/CLAUDE.md` → not repeated here.
- **Concrete over vague.** Every constraint: number, path, or exact string.
- **Rules must be followed or removed.** A violated rule is noise.
- **Memory = surprises only.** Not what `git log` answers — non-obvious decisions only.
- **Platform-guard or remove.** OS-specific blocks must match `uname` or be deleted.
