## Spec: Named Pipe Bridge for External Terminal Injection

**Goal:** Replace unreliable Windows process-handle injection with a named pipe relay for external terminal sessions, so Overlord can reliably send text to Claude sessions running in separate cmd.exe windows.

**Problem:**
When Overlord opens an external terminal via `start "" /D "..." cmd.exe /K claude`, the process chain creates an intermediate cmd.exe (spawned by Node.js with `shell: true`) that dies immediately. Claude's registered parent becomes this dead process. The injector (`inject.ps1`) tries three methods — pipe injection (finds stdin pipe write end via parent), console attachment (`AttachConsole`), and window messages (`WM_CHAR`) — all fail because the parent is gone and the console ownership chain is broken. Meanwhile, the user can type in the window just fine because the window's own keyboard input works.

**Solution:**
Insert a small bridge process between cmd.exe and Claude. The bridge:
1. Creates a Windows named pipe (`\\.\pipe\overlord-{sessionId}`)
2. Reads from the named pipe and writes to its own stdout (which becomes Claude's stdin)
3. Also passes through the console's own stdin so the user can still type normally

Overlord writes to the named pipe instead of using `inject.ps1` for these sessions.

**Inputs / Triggers:**
- User clicks "Open in terminal" or "Open new session" in Overlord UI
- Overlord server receives `terminal:open-external` or `terminal:open-new` WebSocket message

**Outputs / Side effects:**
- A cmd.exe window opens running Claude, with a bridge process relaying stdin
- Overlord can send text to the session by writing to `\\.\pipe\overlord-{sessionId}`
- If Overlord server restarts, it can reconnect to the same named pipe (bridge keeps it alive)
- If the terminal window is closed, the bridge exits and the pipe disappears
- User can still type directly in the terminal window as before

**Architecture:**

```
Overlord Server                    External Terminal Window
      |                                     |
      |  writes to named pipe               |
      |  \\.\pipe\overlord-{sessionId}      |
      |                                     |
      +-----------> [overlord-bridge.exe] --+--> claude.exe stdin
                         |                  |
                    console stdin --------+--> (user typing)
```

The bridge merges two input sources:
1. Named pipe (from Overlord server) 
2. Console stdin (from user typing in the window)

Both feed into Claude's stdin.

**Components:**

### 1. Bridge executable (`overlord-bridge.exe`)

A small compiled program (Node.js single-executable, Go, or Rust — see open questions) that:

- Accepts a pipe name as a command-line argument: `overlord-bridge.exe --pipe overlord-{sessionId}`
- Creates the named pipe `\\.\pipe\overlord-{sessionId}`
- Spawns the remainder of the command line as a child process (e.g., `claude --resume {id}`)
- Reads from both the named pipe and its own stdin concurrently
- Writes everything to the child's stdin
- Forwards child's stdout/stderr to its own stdout/stderr (so the terminal window shows Claude's output)
- Exits when the child process exits
- Cleans up the named pipe on exit

### 2. Modified `openTerminalWindow` (server)

Change the spawn command from:
```
start "title" /D "cwd" cmd.exe /K claude --resume {id}
```
To:
```
start "title" /D "cwd" cmd.exe /K overlord-bridge.exe --pipe overlord-{id} -- claude --resume {id}
```

### 3. Named pipe writer (server)

New module `packages/server/src/pipeInjector.ts`:

- `injectViaPipe(sessionId: string, text: string): Promise<void>` — connects to `\\.\pipe\overlord-{sessionId}`, writes text, disconnects
- Falls back to existing `injectText()` if pipe doesn't exist (for sessions not started by Overlord)
- Connection can be cached/pooled per session to avoid reconnect overhead

### 4. Updated injection routing (server)

In `index.ts`, the `terminal:inject` and `terminal:send-input` handlers:

1. Check if the session has a known pipe name (tracked when we open the terminal)
2. If yes, use `injectViaPipe()` 
3. If no, fall back to existing `injectText()` via `inject.ps1`

Screen reading (`readScreen`) continues using the existing `inject.ps1` mechanism — it uses `AttachConsole` + `ReadConsoleOutput` which works independently of the stdin problem.

**Acceptance Criteria:**
- [ ] Bridge executable exists and can be invoked from cmd.exe
- [ ] `openTerminalWindow` spawns Claude via the bridge
- [ ] Overlord can send text to external terminal sessions via named pipe
- [ ] User can still type directly in the terminal window
- [ ] Both inputs (pipe + keyboard) are merged without corruption (no interleaved partial lines)
- [ ] Session survives Overlord server restart — bridge keeps running
- [ ] After server restart, Overlord can reconnect to existing named pipe
- [ ] If terminal window is closed, pipe is cleaned up (no leaked pipes)
- [ ] If named pipe doesn't exist (session not started by Overlord), falls back to inject.ps1
- [ ] Permission prompt responses work via named pipe
- [ ] Screen reading still works (uses existing inject.ps1 readScreen)
- [ ] No regression for internal PTY sessions (they don't use the bridge)

**Edge Cases:**
- Two Overlord instances trying to write to same pipe simultaneously → named pipe is byte-stream, short writes are atomic on Windows up to pipe buffer size (4096 default). For typical injection (< 1000 chars), this is safe.
- Bridge process crashes → Claude continues running but pipe is gone. User can still type. Overlord falls back to inject.ps1.
- Claude exits → bridge detects child exit, cleans up pipe, exits. cmd.exe returns to prompt (because `/K`).
- Multiple external terminals for same session → each gets unique pipe name based on session ID. Only one at a time since session IDs are unique.

**Cross-platform:**
- Windows: named pipes (`\\.\pipe\overlord-{sessionId}`)
- macOS/Linux: Unix domain sockets (`/tmp/overlord-{sessionId}.sock`)
- Bridge binary compiles for all three platforms
- Server-side `pipeInjector.ts` detects platform and uses the right transport
- On Mac/Linux, existing injection already works — the bridge is additive, not required

**Out of scope:**
- Replacing the internal PTY mechanism (it works fine)
- Changing how screen reading works
- Modifying inject.ps1 (it remains as fallback for sessions not started by Overlord)

**Open questions:**
1. **Bridge language:** Node.js SEA (single executable application) would reuse the existing toolchain but is ~40MB. Go or Rust would produce a ~2-5MB binary. A simple PowerShell script could work but adds startup latency. **Recommendation:** Go — small binary, easy cross-compilation, good Windows named pipe support.
2. **Pipe persistence:** Should the bridge keep the pipe server running (waiting for new connections) or accept one connection at a time? **Recommendation:** Keep listening — Overlord may disconnect and reconnect (e.g., after server restart). Bridge accepts connections in a loop.
3. **Input merging strategy:** Simple byte-level merge (each source writes whenever ready) vs. line-buffered merge (wait for newline before forwarding). **Recommendation:** Byte-level — Claude handles partial input fine, and line buffering would add latency for permission responses that are single keystrokes.
