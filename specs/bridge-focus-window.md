## Spec: Bridge Window Focus

**Goal:** Allow Overlord to bring a bridge-connected terminal window to the front on macOS.

**Inputs / Triggers:**
- User clicks a "Focus" button in the UI for a bridge-connected session
- A `terminal:focus` WebSocket message from the client with `{ sessionId }`

**Outputs / Side effects:**
- The Terminal.app tab hosting the bridge session becomes the frontmost window

---

## Design

### Why title won't work

Terminal.app tabs can have their title changed dynamically (by Claude, shell `PROMPT_COMMAND`, `printf "\e]0;...\a"`, etc.). Titles are unreliable as a stable identifier.

### Why TTY works

Each Terminal.app tab owns a unique PTY slave device (e.g. `/dev/ttys003`). That path never changes for the lifetime of the tab. AppleScript exposes `tty of tab` on Terminal.app, making it straightforward to find the right tab.

### How bridge gets its TTY

When Terminal.app spawns the bridge via `do script`, the bridge's stdin IS the terminal's PTY slave. On macOS, running `tty` as a child command reads stdin's controlling terminal and returns the device path (e.g. `/dev/ttys003`).

---

## Changes

### 1. Bridge: `GETTTY\n` protocol command (`packages/bridge/main.go`, `conpty_unix.go`)

Add a new 6-byte handshake in the pipe listener:

```
"GETTTY\n"  → bridge responds with its TTY path + newline, then closes connection
```

Implementation in `main.go` (in the pipe accept loop, alongside existing NUDGE/RSNUD handlers):

```go
if n == 6 && string(header[:6]) == "GETTTY" {
    ttyPath := getBridgeTTY()   // see below
    conn.Write([]byte(ttyPath + "\n"))
    conn.Close()
    return
}
```

`getBridgeTTY()` — new function, macOS/Unix only (`conpty_unix.go`):

```go
func getBridgeTTY() string {
    out, err := exec.Command("tty").Output()
    if err != nil {
        return ""
    }
    return strings.TrimSpace(string(out))
}
```

On Windows this is a no-op (returns `""`).

### 2. Server: query and store TTY on bridge connect (`packages/server/src/index.ts` or `pipeInjector.ts`)

After the bridge process is up and listening (after `connectBridgePipe` succeeds), query its TTY:

```ts
async function queryBridgeTTY(pipeName: string): Promise<string> {
  // connect to bridge socket, send "GETTTY\n", read response, close
  // returns tty path like "/dev/ttys003" or "" if unsupported
}
```

Store the result in the bridge session state alongside `pipeName`:

```ts
interface BridgeSessionState {
  pipeName: string;
  tty: string;          // e.g. "/dev/ttys003", "" on Windows
  sessionId: string;
}
```

### 3. Server: `terminal:focus` WebSocket handler (`packages/server/src/api/wsHandler.ts`)

```ts
if (type === 'terminal:focus') {
  const sessionId = String(msg.sessionId ?? '');
  const state = bridgeSessionMap.get(sessionId);
  if (!state?.tty) { return; }
  await focusBridgeWindow(state.tty);
}
```

### 4. Server: `focusBridgeWindow(tty)` — macOS only

AppleScript to find the tab whose `tty` matches and activate it:

```applescript
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/ttys003" then
        set selected of t to true
        set index of w to 1
        activate
        return
      end if
    end repeat
  end repeat
end tell
```

Run via `osascript -e '...'`. On non-macOS: no-op.

### 5. Client: Focus button in DetailPanel / WorkerGroup

- Show a small "⌃ Focus" button in the DetailPanel header (or as an icon in WorkerGroup) when `session.bridgeTty` is set (non-empty)
- On click: send `{ type: 'terminal:focus', sessionId }`
- Button only renders on macOS sessions (server can include `bridgeTty` in the snapshot)

---

## Acceptance Criteria

- [ ] Bridge responds to `GETTTY\n` with the correct `/dev/ttys...` path on macOS
- [ ] Bridge returns `""` (or empty line) on Windows without crashing
- [ ] Server queries TTY after bridge connects and stores it in session state
- [ ] TTY is included in the `OfficeSnapshot` so the client can conditionally show the button
- [ ] Clicking "Focus" sends `terminal:focus` and the correct Terminal.app tab comes to front
- [ ] If the TTY is empty (Windows or unknown), the button is hidden and the WS handler is a no-op
- [ ] Focusing does not steal focus when not requested (no side effects on injection paths)

---

---

## Post-implementation: Focus Garbage Fix

**Problem discovered after shipping:** clicking Focus caused `^[[?1;2c`, `^[[O`, and `^[[I` to appear as literal text in the Claude CLI prompt inside Terminal.app.

**Root cause (three layers):**

1. **Outer PTY in cooked mode** — `setRawInputMode()` was a no-op on Unix (`vt_stub.go`). The outer PTY (Terminal.app ↔ bridge) stayed in cooked mode with echo enabled. When Terminal.app sent focus-tracking sequences (`\x1b[I]`, `\x1b[O]`) after gaining OS focus, the TTY line discipline *echoed* them back to the display as `^[[I` before the bridge ever read them.

2. **Bridge stdin not filtering** — Even after fixing cooked/raw mode, focus sequences (`\x1b[I]`, `\x1b[O]`) and DA1 device-attribute responses (`\x1b[?1;2c`) arrived via stdin and were forwarded unfiltered to Claude.

3. **INPUT pipe not filtering** — xterm.js (embedded in Overlord) has focus-reporting mode activated by Claude's TUI (`\x1b[?1004h`). When the browser window lost focus, xterm.js sent `\x1b[O]` via `onData` → `terminal:input` → bridge INPUT pipe → `writeToChild`, bypassing the stdin filter entirely.

**Fixes applied:**

| Layer | File | Change |
|---|---|---|
| Bridge raw mode | `vt_stub.go` | Implemented `setRawInputMode()` using `unix.IoctlGetTermios` / `IoctlSetTermios` (TIOCGETA/TIOCSETA) to disable echo + canonical mode |
| Bridge stdin filter | `filter.go` + `main.go` | `stdinFilter` state machine strips `ESC[?...c` (DA1/DA2) and `ESC[I]` / `ESC[O]` (focus tracking) from all stdin bytes before forwarding to child |
| Bridge INPUT pipe filter | `main.go` | Same `stdinFilter` applied to the INPUT pipe handler (per-connection instance) |
| xterm.js client filter | `XtermTerminal.tsx` | `onData` handler strips `\x1b[I` and `\x1b[O]` before calling `onInput` |

**Why the filter exists at all levels:** each layer defends against a different source — Terminal.app's PTY echo (raw mode), keyboard-path focus events (stdin filter), and xterm.js-originated focus events (INPUT pipe filter + client filter).

---

## Out of scope

- Windows focus (no `SetForegroundWindow` integration in this spec)
- iTerm2 or other terminal emulators (only Terminal.app via AppleScript)
- Auto-focus on session state changes

## Open questions

- None — approach is fully determined for macOS.
