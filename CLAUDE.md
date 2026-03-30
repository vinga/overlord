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
└── client/   React 18 + TypeScript + Vite + CSS Modules
```

**Server data flow:**
1. `SessionWatcher` — watches `~/.claude/sessions/*.json` with chokidar; emits `added/changed/removed` events
2. `TranscriptReader` — reads last 30 lines of `~/.claude/projects/{slug}/{sessionId}.jsonl` to determine session state (`working/thinking/waiting/idle`)
3. `ProcessChecker` — polls `tasklist /fo csv /nh` every 5s; sessions with dead PIDs become `idle`
4. `StateManager` — aggregates all state into `Map<sessionId, Session>`; on change broadcasts `OfficeSnapshot` JSON via WebSocket to all clients

**Session state detection** (from transcript tail):
- File modified < 8s → `working`
- Last event `type:"user"` + age > 2s → `thinking`
- Last event `type:"user"` + age ≤ 2s → `working`
- Last event `type:"assistant"` → `waiting`
- PID dead → `idle`

**Client components:**
- `Office` → CSS Grid of `Room` components
- `Room` → one workspace, contains `WorkerGroup` per session
- `WorkerGroup` → main session worker + subagent workers (70% scale, grouped nearby)
- `Worker` → SVG pixel-art character, animated by state
- `DetailPanel` → right-side slide-in panel, opens on worker click

**Subagents** read from `~/.claude/projects/{slug}/{sessionId}/subagents/agent-{id}.meta.json` + `.jsonl`

## Repository Structure

```
overlord/
├── package.json              # npm workspaces root
├── packages/
│   ├── server/src/
│   │   ├── index.ts          # Express + WS entry
│   │   ├── sessionWatcher.ts
│   │   ├── transcriptReader.ts
│   │   ├── processChecker.ts
│   │   └── stateManager.ts
│   └── client/src/
│       ├── App.tsx
│       ├── hooks/useOfficeData.ts
│       └── components/       # Office, Room, WorkerGroup, Worker, DetailPanel
└── specs/claude-office-monitor.md
```

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

### MANDATORY: No inline code changes

**Every code change, no matter how small, MUST be delegated to a subagent.** This is non-negotiable.

- A one-line CSS tweak → subagent
- Renaming a variable → subagent
- Adding a tooltip → subagent

Never edit files directly in the main conversation. The main conversation is for coordination, planning, and communication only. If you find yourself reaching for Edit, Write, or Read on a source file — stop and spawn a subagent instead.

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
