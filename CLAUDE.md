# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Claude Office Monitor** — real-time visualization of Claude Code sessions as office workers in a 2D top-down view. Sessions are grouped into rooms by workspace (cwd). Subagents appear as smaller characters near their parent. Click a worker to open a detail panel.

## Higher Purpose & Design Standard

The higher purpose of this project is to provide a **truly beautiful, comfortable, and at-a-glance useful overview** of what is happening inside active Claude sessions. Every UI decision must serve this goal.

**Never be lazy with the UI.** When making visual changes:
- Always ask: does this look modern, clean, and polished?
- Think like a designer building a premium product people love to look at (think Linear, Vercel, Raycast)
- Use good typography — prefer modern sans-serif (Inter) over monospace for readable text
- Use proper spacing, visual hierarchy, and color contrast
- After every change, take a screenshot via Chrome DevTools MCP and critically evaluate it
- If it looks dated, cluttered, or "like something from the 90s" — fix it before moving on

## Commands

```bash
# Start both server and client (dev mode)
npm run dev

# Build for production
npm run build

# Server only
npm run dev --workspace=packages/server

# Client only
npm run dev --workspace=packages/client
```

Server runs on `http://localhost:3000` (WebSocket on same port).
Client dev server runs on `http://localhost:5173`.

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

**Data flow:** `SessionWatcher` (chokidar) → `TranscriptReader` (jsonl tail) + `ProcessChecker` (PID poll) → `StateManager` → `OfficeSnapshot` broadcast via WebSocket → client renders office grid.

**Key files:**
- `server/src/session/stateManager.ts` — central state, snapshot broadcast
- `server/src/api/wsHandler.ts` — all WebSocket message handling
- `server/src/pty/injectScheduler.ts` — `scheduleInject()` / `shouldUseExtraEnter()`
- `client/src/components/DetailPanel.tsx` — chat UI, activity feed, terminal embed
- `client/src/hooks/useTerminal.ts` — PTY lifecycle hook

For deep dives, see `docs/`.
```

## Session Matching Rules

**NEVER use CWD-based matching** for anything — not session linking, not /clear detection, not replacement fallbacks. Multiple sessions share the same CWD, making CWD-based matching unreliable. Instead:
- Use **name markers** embedded in `--name` flags (e.g., `___OVR:ptyId`, `___BRG:marker`) for deterministic matching
- Use **PID matching** when the spawner knows the child PID
- Use **sessionId matching** (e.g., `pendingPtyByResumeId`) when the target session ID is known upfront

This has been a recurring source of bugs. Always match by a unique identifier, never by CWD.

## /clear Detection

When Claude Code's `/clear` command runs, it creates a new transcript + sessionId but the PID stays the same and the session file (`{pid}.json`) updates in-place. Detection uses **only PID-based mechanisms** (spec: `specs/clear-detection-simplification.md`):

1. **Live — session file `changed` event** (`sessionEventHandlers.ts`): PID matches existing session with different sessionId → `transferSessionState()`
2. **Periodic — stale transcript poll** (`transcriptWatcher.ts`, 3s interval): if transcript is stale, re-reads `{pid}.json` and detects sessionId mismatch
3. **Startup — PID file comparison** (`stateManager.detectClearOnStartup()`): compares known-sessions' stored sessionId with actual `{pid}.json` files, called after `sessionWatcher.start()`
4. **UI-injected /clear** (`transcriptWatcher.ts` pending clear): explicit mechanism when /clear is injected via Overlord UI — not guessing, uses `consumePendingClearReplacement()`

**Do NOT add** new /clear detection mechanisms (CWD matching, transcript content scanning, orphan scans, bridge marker suffix matching). These were all removed because they raced, overlapped, and caused cascading bugs. If /clear is missed, fix the existing 3 paths instead of adding a 4th.

## Development Approach: Spec Driven Development

All work in this project follows **Spec Driven Development (SDD)**. This means:

### The Workflow

1. **Spec first** — before writing any code, produce a spec. The spec defines:
   - What the feature/change does (goal, inputs, outputs, constraints)
   - Acceptance criteria written as verifiable statements
   - Edge cases and error conditions

2. **Review the spec** — present the spec to the user and get explicit approval before proceeding. Do not start implementation until the spec is agreed upon.

3. **Implement against the spec** — write only what is needed to satisfy the spec. Do not add anything not covered by the acceptance criteria.

4. **Verify against the spec** — confirm each acceptance criterion is met. If something cannot be verified, flag it.

### Spec Format

When writing a spec, use this structure:

```
## Spec: <feature name>

**Goal:** One-sentence description of what this achieves.

**Inputs / Triggers:** What initiates this behavior.

**Outputs / Side effects:** What the system produces or changes.

**Acceptance Criteria:**
- [ ] Criterion 1
- [ ] Criterion 2
- ...

**Out of scope:** What this spec explicitly does NOT cover.

**Open questions:** Anything needing clarification before implementation.
```

### Rules

- Never start implementing before the spec is approved.
- If a new requirement surfaces during implementation, stop and update the spec first.
- Keep specs as files in `specs/` directory. Additional feature specs are already present there — check before writing new ones.

### Think Before Coding

Before implementing any solution, **stop and think through the design space**:

1. **Trace the data flow end-to-end** — what does each approach assume? What existing behavior will break?
2. **Consider at least 2-3 alternatives** — compare tradeoffs before picking one.
3. **Understand the tools** — if using a CLI flag or API, verify what it actually does (e.g., does it create files? Where does it write?).
4. **One well-thought-out approach beats three hasty iterations** — don't implement, discover it's broken, pivot, repeat.

If you catch yourself about to start a second approach after the first failed, pause and think about _why_ it failed. The root cause often points to the right solution.

## Browser Verification

After any client-side code change, verify rendering and behavior in the browser using the Chrome DevTools MCP before marking work complete. Steps:
1. Use `mcp__chrome-devtools__*` tools to inspect the running app at `http://localhost:5173`
2. Check for console errors, layout issues, and that the changed behavior works as expected
3. If issues are found, fix them before considering the task done

## Independence & Self-Testing

Be maximally independent. Never ask the user to test or verify something you can test yourself.

**Always self-verify before reporting done:**
- **UI changes** — use Chrome DevTools MCP (`mcp__chrome-devtools__*`) to take screenshots, check console errors, and verify behavior at `http://localhost:5173`
- **Backend changes** — write ad-hoc test scripts (small Node.js or curl commands via Bash) to hit the server endpoints directly and confirm they work
- **Logic changes** — reason through edge cases or write a quick inline test

Only ask the user to test when the verification genuinely requires human judgment (e.g. "does this feel right?") or physical interaction the tools can't replicate.

**If the frontend (port 5173) or backend (port 3000) is not running, start it proactively with `npm run dev` — do not ask the user.** This is part of being maximally independent.

### Restarting the server on Windows

Kill live owner only (ignore `TimeWait` with `OwningProcess=0` — they resolve on their own):

```powershell
powershell -Command "
\$conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { \$_.OwningProcess -gt 0 }
foreach (\$c in \$conns) { Stop-Process -Id \$c.OwningProcess -Force -ErrorAction SilentlyContinue }
Write-Host 'done'
"
```

Then start the server:
```bash
cd C:/projekty/overlord && npm run dev --workspace=packages/server
```

**Starting the client (if npm not found in background shell):**
```bash
cd C:/projekty/overlord/packages/client && C:/projekty/overlord/node_modules/.bin/vite.cmd
```

## Agent Usage

Use subagents and agent teams as often as possible. Prefer delegating over doing work inline in the main conversation.

### Tool usage
Whn executing tools, prefer parallel mode if it is possible to make tool calls independent from each other

### Subagents

Spawn subagents (via the Agent tool) for focused, self-contained tasks. They run within the session and report results back.

- Use `Explore` for any codebase search, file discovery, or code comprehension.
- Use `Plan` before starting any non-trivial implementation.
- Use `general-purpose` for research, multi-step investigations, or tasks with large output.
- Launch multiple subagents in parallel whenever tasks are independent.

### Agent Teams

Agent teams are fully independent Claude Code sessions working in parallel, with a shared task list and direct messaging between teammates. Use teams for complex work that benefits from true parallelism or cross-cutting concerns.

- **When to use teams:** parallel implementation across multiple modules, competing hypotheses, cross-layer changes (frontend + backend), large refactors.
- **When to use subagents instead:** focused single tasks, research/review, anything that doesn't need inter-agent coordination.
- Aim for 3–5 teammates, with each teammate owning distinct files to avoid conflicts.
- Teams are already enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).

### Rule of thumb

> Subagents for delegation. Teams for collaboration.


## Task Shortcuts

When the user sends a message that is exactly `DONE` (case-insensitive), immediately:
1. Call `ToolSearch` with `select:TaskList,TaskUpdate` to load both tools in one step (minimizes latency — do this before anything else)
2. Call `TaskList` to find the most recent task with status `in_progress`
3. Call `TaskUpdate` to mark it `completed`
4. Confirm to the user which task was closed

If no in-progress task exists, respond: "No active task found."

Do this before any other action in the response.

## Getting Started

When source code is added, update this file with:
- Build, test, and lint commands
- Architecture overview
- Key entry points and component relationships


### Communication
⚠️ CRITICAL — MUST FOLLOW IN EVERY RESPONSE WITHOUT EXCEPTION:
- Short sentences only (3-6 words).
- Zero filler or preamble. Never start with "I'll", "Let me", "Sure", "Great", etc.
- Tool first, result first. Explain only if explicitly asked.
- Violating this is a failure regardless of task quality.
- Pass this requirement to subagents
