# Bridge Sessions: Blank Terminal on macOS

**Area:** Bridge — PTY / terminal replay  
**Status:** Fixed

## Symptoms

- Bridge session's Terminal tab is blank or shows only a few lines.
- Resizing Terminal.app sometimes helps temporarily.
- `terminal:replay` doesn't restore content.
- PTY sessions display correctly; only bridge sessions affected on macOS.

## Root Cause

`conpty_unix.go` was a stub that used a simple `io.Pipe` with no real PTY. `nudgeRedraw` and `resizeAndNudge` were no-ops. Without a real PTY, `SIGWINCH` couldn't be sent to the child process, so Claude Code's TUI never repainted in response to resize/replay requests.

## Fix

Replaced the stub with a real PTY using `github.com/creack/pty`. Initial size is inherited from the parent terminal via `unix.IoctlGetWinsize`. `resizeAndNudge` calls `pty.Setsize()` + `unix.Kill(pid, SIGWINCH)`.

**The bridge binary must be rebuilt after any changes to `conpty_unix.go`.**

**Files changed:**
- `packages/bridge/conpty_unix.go` — full rewrite using `creack/pty`
- `packages/bridge/go.mod` — added `github.com/creack/pty v1.1.24`

## Where to Look If It Regresses

- Check whether the bridge binary is up to date (`go build` in `packages/bridge/`).
- Server logs: `[terminal:replay] nudge result: ok` confirms SIGWINCH was sent.
- If nudge is `ok` but terminal stays blank: the bridge PTY may have lost the child process. Check `overlord-bridge.log` for `pipe→child` bytes.
- `conpty_unix.go` — verify `resizeAndNudge` calls both `pty.Setsize` and `SIGWINCH`.
