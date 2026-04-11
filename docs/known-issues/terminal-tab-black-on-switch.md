# Terminal Tab Black / Partial Content on Tab Switch

**Area:** Terminal tab — xterm.js  
**Status:** Fixed

## Symptoms

- Click Terminal tab → full history visible.
- Switch to Conversation tab and back → black screen, or only the last user message + status bar shown.
- Resizing the browser window sometimes restores content.

## Root Cause

`XtermTerminal` was conditionally rendered (`{activeTab === 'terminal' && ...}`). On tab switch, React unmounts and remounts the component. The xterm.js instance is destroyed and recreated, losing all scrollback buffer. On remount, only the last buffered repaint frame (since the last `\x1b[?2026h` checkpoint) is replayed — for a session in "waiting" state this may be just a few lines.

## Fix

`XtermTerminal` is now always mounted for live PTY/bridge sessions, toggled via `display: none / flex` rather than conditional rendering. The xterm instance (and its 5000-line scrollback buffer) survives tab switches.

Key detail: ResizeObserver fires when an element transitions from `display:none` to a visible display value (dimensions go from 0 to positive). This triggers `fitAddon.fit()` and the SIGWINCH nudge automatically when the terminal tab is opened, without manual polling.

**Files changed:**
- `packages/client/src/components/DetailPanel.tsx` — terminal section changed from `{activeTab === 'terminal' && (...)}` to always-rendered div with `style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}`
- `packages/client/src/components/XtermTerminal.tsx` — output handler registered immediately on mount (not deferred to after fit), so output accumulates in scrollback even while hidden; `tryFit()` called via ResizeObserver

## Where to Look If It Regresses

- `DetailPanel.tsx` — search for `activeTab === 'terminal'`. The terminal section must use `display` toggling, not conditional rendering.
- `XtermTerminal.tsx` — output handler must be registered immediately on mount, not inside a `tryFit` callback.
- If content is blank after switch: check whether `terminal:replay` is being sent with correct dimensions (ResizeObserver should trigger fit → replay on tab open).
