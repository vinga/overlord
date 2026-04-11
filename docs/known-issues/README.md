# Known Issues

Recurring bugs and their fixes. Each issue documents root cause, symptoms, and resolution so future debugging starts from a known baseline.

## Injection

| Issue | Area | Status |
|-------|------|--------|
| [@file autocomplete consumes \r on inject](at-file-autocomplete-enter-race.md) | Injection / Bridge | Fixed (3-step sequence) |
| [Bridge sessions taking PTY stdin path](bridge-session-pty-path.md) | Injection / Bridge | Fixed (`!isBridge` guard) |
| [Queued messages silently lost](queued-messages-lost.md) | Injection / WebSocket | Fixed (boolean return) |
| [Pending messages disappear on session switch](pending-messages-lost-on-session-switch.md) | Injection / Client state | Fixed (per-session map) |

## Terminal / PTY

| Issue | Area | Status |
|-------|------|--------|
| [Compacting detection missing or delayed](compacting-detection.md) | PTY / Transcript | Fixed (rolling buffer + shrink reset) |
| [Terminal tab black / partial on tab switch](terminal-tab-black-on-switch.md) | Terminal / xterm.js | Fixed (always-mounted + display toggle) |
| [Bridge sessions blank terminal on macOS](bridge-blank-terminal-macos.md) | Bridge / PTY | Fixed (real PTY in conpty_unix.go) |

## Session Lifecycle

| Issue | Area | Status |
|-------|------|--------|
| [Bridge session name duplication (`___BRG:xxx___BRG:yyy`)](bridge-session-name-duplication.md) | Bridge / Session naming | Fixed (stripInternalMarkers) |
| [CWD-based session matching causes wrong links](cwd-based-matching.md) | Session lifecycle | Removed from codebase |
