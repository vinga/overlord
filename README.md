# Overlord — Claude Office Monitor

Real-time visualization of your active [Claude Code](https://claude.ai/code) sessions as office workers in a 2D top-down view. Sessions are grouped into rooms by workspace, with subagents orbiting their parent. Click any worker to open a live activity feed, embedded terminal, and command injection.

## Features

- **Office view** — live grid of workspace rooms with animated worker avatars and state indicators
- **Activity feed** — message-by-message transcript with markdown rendering, code highlighting, and diff views
- **Terminal integration** — embedded xterm.js terminal with two-way command injection via named pipes
- **Permission prompts** — inline yes/always/no UI when Claude asks for permission
- **Subagent visualization** — subagents appear as smaller characters near their parent, with drill-down
- **Session state detection** — real-time working/thinking/waiting/idle states from transcript analysis
- **AI-powered labels** — automatic session naming and task summaries via Claude Haiku
- **Drag-to-reorder** — rearrange workspace rooms in the grid
- **Event log** — alternative view with color-coded real-time event stream

## Quick Start

```bash
# Install dependencies
npm install

# Start both server and client
npm run dev
```

- **Client:** http://localhost:5173
- **Server / WebSocket:** http://localhost:3000

## Architecture

```
packages/
├── server/   Node.js + TypeScript + Express + WebSocket + chokidar
├── client/   React 18 + TypeScript + Vite + CSS Modules
└── bridge/   Go binary — named-pipe relay for terminal injection
```

### How it works

1. **SessionWatcher** monitors `~/.claude/sessions/*.json` for session lifecycle events
2. **TranscriptReader** reads transcript tails (`.jsonl`) to determine session state
3. **ProcessChecker** polls the OS process list to detect dead PIDs
4. **StateManager** aggregates everything into an `OfficeSnapshot` and broadcasts via WebSocket
5. **Bridge** (optional) enables reliable terminal I/O through named pipes

### Session states

| State | Detection |
|-------|-----------|
| `working` | Transcript modified < 8s ago |
| `thinking` | Last event is user message, age > 2s |
| `waiting` | Last event is assistant message |
| `idle` | Process no longer running |

## Project Structure

```
packages/server/src/
├── session/          Session lifecycle & state
│   ├── stateManager.ts        Aggregates state, broadcasts snapshots
│   ├── sessionWatcher.ts      Watches session files (chokidar)
│   ├── transcriptReader.ts    Reads transcript tails for state detection
│   ├── transcriptWatcher.ts   Watches transcript files, /clear detection
│   └── processChecker.ts      Polls OS for alive PIDs
├── pty/              Terminal management
│   ├── ptyManager.ts          ConPTY/PTY session lifecycle
│   ├── consoleInjector.ts     PowerShell SendInput injection (Windows)
│   └── pipeInjector.ts        Named-pipe injection via bridge binary
├── ai/               Classification & LLM
│   ├── aiClassifier.ts        Session labeling & completion summaries
│   └── claudeQuery.ts         Claude API wrapper (Haiku worker)
└── api/              HTTP & WebSocket
    ├── apiRoutes.ts           REST endpoints
    └── wsHandler.ts           WebSocket message handlers

packages/client/src/
├── App.tsx                    Root: view switching, state orchestration
├── components/
│   ├── Office.tsx             CSS Grid of rooms
│   ├── Room.tsx               Workspace card with drag-to-reorder
│   ├── Worker.tsx             SVG avatar with state indicators
│   ├── DetailPanel.tsx        Activity feed, chat, terminal sidebar
│   ├── TaskListPanel.tsx      Room-level agents/tasks panel
│   └── XtermTerminal.tsx      xterm.js terminal emulator
└── hooks/
    ├── useOfficeData.ts       WebSocket connection + auto-reconnect
    └── useTerminal.ts         PTY session lifecycle
```

## Docker

See [docs/docker.md](docs/docker.md) for running with Docker + Traefik reverse proxy.

## Tech Stack

**Server:** Node.js, TypeScript, Express, ws, chokidar, node-pty
**Client:** React 18, TypeScript, Vite, CSS Modules, xterm.js, marked
**Bridge:** Go 1.21 (named-pipe relay for Windows terminal integration)

## Platform Support

- **Windows** — full support including ConPTY terminal injection and bridge pipes
- **macOS/Linux** — core features work; terminal injection uses standard PTY

## License

MIT
