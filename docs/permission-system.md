# Permission Detection & Injection System

Technical reference for the Overlord permission prompt detection pipeline and console injection mechanism.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Detection](#2-detection)
3. [Injection](#3-injection)
4. [State Management](#4-state-management)
5. [Known Issues & Gotchas](#5-known-issues--gotchas)
6. [Debugging Checklist](#6-debugging-checklist)
7. [Testing](#7-testing)

---

## 1. Architecture Overview

### Full Pipeline

```
[Claude process]
  │  Permission dialog shown on terminal screen
  │
  ▼
[permissionChecker.ts]            ← polls every 3 s via readScreen(pid)
  │  AttachConsole(pid) → ReadConsoleOutputCharacter → text
  │  looksLikePermissionPrompt(text) → true/false
  │
  ▼
[StateManager.setNeedsPermission()]  ← sets session.needsPermission = true
  │  Broadcasts updated OfficeSnapshot via WebSocket
  │
  ▼
[WebSocket → client]
  │  Session object carries: needsPermission, permissionPromptText
  │
  ▼
[DetailPanel.tsx: <PermissionPrompt>]  ← rendered when session.needsPermission is set
  │  Buttons: Yes (\r) | Yes, allow this session (\x1b[B\r) | No (\x1b)
  │  User clicks button → fetch POST /api/sessions/:id/inject { text }
  │
  ▼
[index.ts: POST /api/sessions/:sessionId/inject]
  │  Looks up session.pid from StateManager
  │  Calls injectText(pid, text)
  │  On success: stateManager.setNeedsPermission(sessionId, false)
  │
  ▼
[consoleInjector.ts: injectText()]   ← sends JSON command to PowerShell daemon stdin
  │  {"pid": 1234, "text": "\r", "extraEnter": false}
  │
  ▼
[inject.ps1 daemon]                  ← persistent PowerShell process (stdio: pipe)
  │  Calls PipeInjector.Inject(pid, text, extraEnter)
  │  1. TryPipeInject  → usually returns -5 for IntelliJ ConPTY
  │  2. TryConsoleInput → AttachConsole(pid) + WriteConsoleInput to CONIN$
  │  3. TryWindowMessage → walks process tree for MainWindowHandle (fallback)
  │
  ▼
[Claude process] receives the key events, permission dialog dismissed
```

### File Ownership

| Responsibility | File |
|---|---|
| Screen polling & pattern matching | `packages/server/src/permissionChecker.ts` |
| PowerShell daemon management & public API | `packages/server/src/consoleInjector.ts` |
| Console injection logic (C# embedded in PS) | `packages/server/inject.ps1` |
| Permission state fields & suppress window | `packages/server/src/stateManager.ts` |
| Session type definition | `packages/server/src/types.ts` |
| HTTP endpoint `/api/sessions/:id/inject` | `packages/server/src/index.ts` |
| Permission UI component | `packages/client/src/components/DetailPanel.tsx` |
| (Dead) transcript-based detection | `packages/server/src/transcriptReader.ts` |

---

## 2. Detection

### How `permissionChecker.ts` Polls

`startPermissionChecker()` (`permissionChecker.ts:47`) is called once at startup from `index.ts:63`. It is a no-op on non-Windows platforms (`IS_WINDOWS` guard at line 4).

The checker lazy-imports `readScreen` from `consoleInjector.ts` to avoid loading the PowerShell daemon until needed (lines 53–58).

**Poll interval:** 3 000 ms (`setInterval` at line 63).

On each tick:
1. Get all session IDs from StateManager.
2. Skip sessions with `state === 'idle'` (no point scanning dead processes).
3. For each live session: call `readScreen(session.pid)` — this attaches to the process console and reads the last 25 lines of the screen buffer.
4. Run `looksLikePermissionPrompt(text)` on the result.
5. If prompt detected: call `stateManager.setNeedsPermission(id, true, promptText)` with cleaned/extracted text (lines 81–83).
6. If no prompt: increment a miss counter but **do not clear** `needsPermission` (lines 86–88). Clearing is delegated to the transcript watcher and to the HTTP endpoint after successful injection.

**Hysteresis:** `missCount` (a `Map<string, number>` at line 61) tracks consecutive non-detections. The comment says clearing is transcript-owned, so miss count currently only increments but never triggers a clear. Its main value is as a future guard against acting on a single spurious miss.

### Pattern Matching: PRIMARY + SECONDARY

```typescript
// permissionChecker.ts:9-13
const PRIMARY_PATTERN   = /do you want to/i;
const SECONDARY_PATTERNS = [
  /esc to cancel/i,
  /yes,? (?:and )?allow .* (?:during|for) this session/i,
];
```

`looksLikePermissionPrompt()` (line 15) requires **both**:
- The primary pattern matches, **AND**
- At least one secondary pattern matches.

**Why dual-pattern?**
The phrase "Do you want to" appears frequently in Claude's generated text (e.g. "Do you want to proceed with refactoring..."). Requiring a secondary signal eliminates false positives. The secondary patterns are specific to the Claude permission dialog UI:

- `esc to cancel` — appears in the bottom hint line of every permission dialog.
- `yes,? (?:and )?allow .* (?:during|for) this session` — matches the "Yes, and allow..." / "Yes, allow ... for this session" option text.

### Known Prompt Variants

Claude Code shows different dialog text depending on the operation:

| Prompt type | Primary text | Notes |
|---|---|---|
| Generic tool permission | "Do you want to proceed?" | Shown for bash execution, network calls, etc. |
| File edit permission | "Do you want to make this edit to `<filename>`?" | Shown when `--dangerously-skip-permissions` is not set |
| MCP tool approval | "Do you want to allow..." | Covers MCP server tool calls |

All variants contain "do you want to" and the "ESC to cancel" hint, so both patterns fire reliably across variants.

### `extractPromptBlock()` and `cleanText()`

Before storing `permissionPromptText`, the raw screen text is processed:

1. **`extractPromptBlock(text)`** (line 20): Finds the last non-empty line, then takes up to 15 lines above it. This isolates the dialog frame from earlier terminal content.
2. **`cleanText(text)`** (line 28): Strips non-printable characters (keeps only `\x20-\x7E`), trims line ends, and collapses consecutive blank lines into one. The result is stored as `permissionPromptText` and displayed verbatim in the `<PermissionPrompt>` component as a `<pre>` block.

### Why `transcriptReader.ts` `needsPermission` Is Dead Code

`readTranscriptState()` in `transcriptReader.ts` declares and returns `needsPermission` (lines 311, 354), but the variable is **always `undefined`**:

```typescript
// transcriptReader.ts:311
let needsPermission: boolean | undefined;
// ...
// (no code ever sets needsPermission = true)
// ...
return {
  // ...
  needsPermission: needsPermission || undefined,  // line 354 — always undefined
};
```

The original design was to detect permission prompts from tool_use patterns in the transcript. That was superseded by the screen-reader approach in `permissionChecker.ts`, but the unused field was never removed from `transcriptReader.ts`.

**Consequence:** Detection is 100% screen-reader-driven. The `result.needsPermission` value read in `stateManager.ts:addOrUpdate()` (line 55) and `refreshTranscript()` (line 160) is always falsy and has no effect on the actual permission state.

### Race Condition: `refreshTranscript` Clearing

`stateManager.refreshTranscript()` (line 138) runs on every transcript file change (chokidar) and every 3-second periodic tick. At line 183–193 it clears `needsPermission` when `result.needsPermission` is false:

```typescript
// stateManager.ts:183-193
if (!result.needsPermission) {
  session.needsPermission = undefined;
  session.permissionPromptText = undefined;
} else if (!session.needsPermission) {
  const suppressed = session.permissionApprovedAt &&
    Date.now() - session.permissionApprovedAt < 30_000;
  if (!suppressed) {
    session.needsPermission = result.needsPermission;
  }
}
```

Since `result.needsPermission` is always falsy (dead code), the `if (!result.needsPermission)` branch always fires when `changed` is true — meaning every transcript change would clear the permission flag.

**Why this doesn't break things in practice:** A Claude process showing a permission dialog is **frozen** — it cannot proceed, so the transcript file does not change (no new JSONL lines, no mtime update). The `changed` variable at line 151 stays `false`, so the clear block at line 183 is never reached while the dialog is visible. The permission flag survives until the inject succeeds.

This is a **fragile assumption**: if anything else touches the transcript file while the dialog is showing (e.g. a background tool result arriving just before the dialog), the permission state would be incorrectly cleared. It has not been observed in practice because Claude's execution model is sequential — it cannot write to transcript while waiting for user input.

---

## 3. Injection

### Full Path: Click → inject.ps1

1. **Client button click** (`DetailPanel.tsx:157,164,173`):
   ```tsx
   // Yes
   onClick={() => void respond('\r')}
   // Yes, allow this session
   onClick={() => void respond('\x1b[B\r')}
   // No
   onClick={() => void respond('\x1b')}
   ```

2. **`respond()` function** (`DetailPanel.tsx:130–147`): POSTs to `/api/sessions/${sessionId}/inject` with `{ text }`. Sets `responding = true` while the request is in flight; sets `error = true` for 3 seconds on non-2xx response.

3. **HTTP endpoint** (`index.ts:450–474`): `POST /api/sessions/:sessionId/inject`
   - Validates `text` is present.
   - Looks up `session.pid` from StateManager.
   - Calls `await injectText(session.pid, text)`.
   - On success: calls `stateManager.setNeedsPermission(sessionId, false)` which starts the 30-second suppress window.
   - Returns `{ ok: true }` or `{ error: ... }`.

4. **`injectText(pid, text, extraEnter)`** (`consoleInjector.ts:91–100`): Ensures the PowerShell daemon is running, then writes a JSON command to its stdin:
   ```json
   {"pid": 1234, "text": "\r", "extraEnter": false}
   ```
   Awaits the response line from the daemon's stdout.

5. **`inject.ps1` daemon main loop** (line 433+): Parses each JSON line, calls `PipeInjector.Inject(pid, text, extraEnter)`, writes `{"ok":true}` or `{"ok":false,"error":"..."}`.

### The PowerShell Daemon

`consoleInjector.ts` spawns a single persistent `powershell.exe` process (`startDaemon()`, line 20):

```typescript
proc = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', SCRIPT,
], { stdio: ['pipe', 'pipe', 'pipe'] });
```

Communication is newline-delimited JSON over stdio. The daemon signals readiness with `{"ready":true}` on startup (inject.ps1:429). `ensureDaemon()` (line 75) polls every 50 ms for up to 15 seconds waiting for `ready = true`.

All in-flight requests are tracked in the `pending` array (line 18). Responses are matched FIFO — the daemon processes one command at a time.

**Daemon stderr** (`consoleInjector.ts:70–72`): The `[inject-debug]` lines from `inject.ps1` (e.g. `[inject-debug] pid=X pipe=-5`) flow to stderr and are logged with `console.warn('[injector stderr]', ...)`.

### inject.ps1: Method Order

`PipeInjector.Inject()` (inject.ps1 line 386) tries three methods in order:

```
TryPipeInject → TryConsoleInput → TryWindowMessage
```

Returns `null` on first success, or a formatted error string listing all three result codes.

#### Method 1: `TryPipeInject` (line 150)

**Strategy:** Enumerate all handles system-wide via `NtQuerySystemInformation(SystemExtendedHandleInformation)`. Find read-only pipe handles in the target process (stdin candidates). Find the corresponding write end elsewhere in the system. Write to it via `WriteFile`.

**Result codes:**
| Code | Meaning |
|---|---|
| `0` | Success |
| `-1` | `OpenProcess` failed (no PROCESS_DUP_HANDLE access) |
| `-4` | `NtQuerySystemInformation` failed |
| `-5` | No read-only pipe handles found in target process |
| `-6` | No write-end candidates found |
| `-7` | Found candidates but all writes failed |

**Why it returns `-5` for IntelliJ ConPTY sessions:**
When Claude runs inside an IntelliJ terminal (which uses ConPTY), the Claude process's stdin handle is `FILE_TYPE_CHAR` (a character device / pseudoconsole), **not** `FILE_TYPE_PIPE` (type 3). The `GetFileType(hd) == FILE_TYPE_PIPE` check at line 174 fails for all stdin handles, so `stdinObjects` remains empty and the function returns `-5`.

This is confirmed by the `[inject-debug] pipe=-5` line in server stderr for every IntelliJ session.

#### Method 2: `TryConsoleInput` (line 264)

**Strategy:** `FreeConsole()` → `AttachConsole(pid)` → open `CONIN$` → `WriteConsoleInput` with properly structured `INPUT_RECORD` entries.

**Why it works:** `AttachConsole` connects the calling PowerShell process to the target's console host (conhost or ConPTY host). Writing `KEY_EVENT` records to `CONIN$` delivers them into the console input queue that Claude's readline is reading from.

**Key implementation details:**

- The `full` string (line 277) adds `\r` unless the input is already `\r`-terminated or is a bare ESC:
  ```csharp
  string full = (text == "\x1b" || text.EndsWith("\r")) ? text : text + "\r";
  ```
  This prevents double-enter for "Yes" (`\r`), correctly sends no trailing enter for "No" (`\x1b`), and adds enter for "Yes, allow this session" (`\x1b[B\r` → already ends with `\r`).

- Each character is sent as a **key-down + key-up pair** (lines 280–290), matching how real keyboard input arrives.

- `ParseKeys()` (line 241) translates VT escape sequences into proper virtual key codes:
  | Sequence | VK | Scan | `dwControlKeyState` |
  |---|---|---|---|
  | `\x1b[A` | `0x26` (VK_UP) | `0x48` | `0x100` (ENHANCED_KEY) |
  | `\x1b[B` | `0x28` (VK_DOWN) | `0x50` | `0x100` (ENHANCED_KEY) |
  | `\x1b[C` | `0x27` (VK_RIGHT) | `0x4D` | `0x100` (ENHANCED_KEY) |
  | `\x1b[D` | `0x25` (VK_LEFT) | `0x4B` | `0x100` (ENHANCED_KEY) |
  | `\x1b` (bare) | `0x1B` (VK_ESCAPE) | `0x01` | `0` |

- **`ENHANCED_KEY` flag (0x100) is required for arrow keys.** ConPTY checks `dwControlKeyState` when translating `KEY_EVENT` records to VT sequences. Without `0x100`, arrow key VK codes are silently ignored — the events are accepted by `WriteConsoleInput` (reported as "written") but never delivered to the application as cursor keys.

**Return value:** The error code from `GetLastError()` after `WriteConsoleInput`. `0` means success. However, `WriteConsoleInput` reports "written=N" based on records accepted by the kernel buffer, not on records consumed by the application. There is no true delivery confirmation.

#### Method 3: `TryWindowMessage` (line 357)

**Strategy:** Walk the process tree up to 4 levels to find an ancestor process with a `MainWindowHandle`. Send `WM_CHAR` messages.

**Why it is useless for IntelliJ:** IntelliJ's terminal runs in the IDE JVM process tree. The actual terminal is rendered in a JFrame/JWindow that does not have a `MainWindowHandle` visible to .NET's `Process.MainWindowHandle`. The walk finds no usable window, returns `-1`.

This method exists as a last-resort fallback for hypothetical native Win32 applications where neither pipe injection nor console attachment work.

### Key Sequences Reference

| Button | Text sent | Resulting keys | Effect |
|---|---|---|---|
| Yes | `\r` | Enter (VK 0x0D) | Selects first option (Yes / default) |
| Yes, allow this session | `\x1b[B\r` | Arrow-Down + Enter | Moves selection to "Yes, allow..." then confirms |
| No | `\x1b` | Escape (VK 0x1B) | Cancels / dismisses dialog |

The `\x1b` (No / ESC) case specifically must **not** have a trailing `\r`. `TryConsoleInput`'s `full` construction handles this:
```csharp
string full = (text == "\x1b" || text.EndsWith("\r")) ? text : text + "\r";
```

---

## 4. State Management

### Session Fields (from `types.ts:27`)

| Field | Type | Purpose |
|---|---|---|
| `needsPermission` | `boolean \| undefined` | Whether a permission dialog is currently showing |
| `permissionPromptText` | `string \| undefined` | Cleaned/extracted text from the screen to display in the UI |
| `permissionApprovedAt` | `number \| undefined` | Timestamp (ms) when the user last clicked Yes/No — used for suppress window |

### 30-Second Suppress Window

After the user responds to a permission prompt, `setNeedsPermission(sessionId, false)` is called from the HTTP endpoint (`index.ts:467`). This sets `permissionApprovedAt = Date.now()` (stateManager.ts:265).

For the next 30 seconds, any call to `setNeedsPermission(id, true, ...)` from the permission checker is silently ignored:
```typescript
// stateManager.ts:252-255
if (session.permissionApprovedAt && Date.now() - session.permissionApprovedAt < 30_000) {
  return;
}
```

**Why 30 seconds?** After the user clicks Yes, Claude resumes execution. For a few seconds the terminal still shows content that includes the old dialog text (before the screen scrolls). Without the suppress window, `permissionChecker.ts` would immediately re-detect the "resolved" dialog text and set `needsPermission` again, creating a false re-prompt loop.

### Critical Bug (Now Fixed): `addOrUpdate()` Destroying the Suppress Window

`addOrUpdate()` (`stateManager.ts:30`) is called by the session watcher on every `added` and `changed` event. Before the fix, it built the `Session` object from scratch on every call, meaning `permissionApprovedAt` (which is only set by `setNeedsPermission`) was always `undefined` in the new object.

The bug sequence was:
1. User clicks Yes → `permissionApprovedAt = Date.now()` set.
2. Session file changes (Claude resumes writing transcript).
3. `sessionWatcher` fires `changed` → `addOrUpdate()` → new Session object with `permissionApprovedAt: undefined`.
4. `permissionChecker` next tick → `setNeedsPermission(true)` → suppress check fails (no timestamp) → `needsPermission` set again.
5. UI re-shows the permission prompt within ~3 seconds of dismissal.

**The fix** (stateManager.ts:111–113): `addOrUpdate()` now explicitly preserves these fields from the existing session:
```typescript
needsPermission: needsPermission || existingSession?.needsPermission,
permissionPromptText: needsPermission ? undefined : existingSession?.permissionPromptText,
permissionApprovedAt: existingSession?.permissionApprovedAt,
```

The `needsPermission || existingSession?.needsPermission` expression ensures that:
- If transcript indicates permission needed → set it (though transcript always returns `undefined`, so existing value is preserved).
- If transcript is clear → preserve existing value (the screen-reader-set flag survives transcript changes).

`permissionApprovedAt` is unconditionally preserved from the existing session, which keeps the suppress window alive across session file changes.

---

## 5. Known Issues & Gotchas

### `transcriptReader.ts` `needsPermission` Is Dead Code

`readTranscriptState()` always returns `needsPermission: undefined`. Do not add logic that relies on transcript-based detection without first implementing it in `transcriptReader.ts`. The field declaration, assignment, and return exist (lines 311, 354) but the assignment block was never written.

### `approvePermission()` in `consoleInjector.ts` Is Dead Code

`consoleInjector.ts:102–113` exports `approvePermission()`, which sends `{ action: 'consoleInput', pid, text }` to the daemon. This is **not** used anywhere in the codebase — the HTTP endpoint calls `injectText()` directly. The `action: 'consoleInput'` branch in `inject.ps1` (line 439) handles this format, but `approvePermission()` is never imported or called. It can be safely removed.

The difference from `injectText()`: `approvePermission()` has a 5-second silent timeout fallback that resolves the promise even on failure. `injectText()` rejects on failure, letting the HTTP endpoint return a 500.

### `refreshTranscript` Permission Clearing Is Fragile

The `refreshTranscript()` clear logic (stateManager.ts:183) depends on `result.needsPermission` always being falsy (because transcriptReader never sets it). If transcriptReader is ever fixed to actually detect permissions, the clearing logic would behave differently — it would only clear when `result.needsPermission` transitions to false, not on every changed transcript. This would be correct behavior, but is worth auditing at that point.

### `TryConsoleInput` Reports `written=N` Even If 0 Keys Were Consumed

`WriteConsoleInput` returns the number of INPUT_RECORD structures accepted into the kernel's console input buffer. It does not indicate whether the target application dequeued them. If the Claude process has already exited or detached from the console by the time the records arrive, the write succeeds but nothing happens. The inject endpoint returns `{ ok: true }` regardless.

### Subagent Permission Prompts

When a subagent triggers a permission dialog, the dialog appears on the **parent session's terminal** (same CONIN$/CONOUT$ as the parent). The parent's PID is the correct target for both `readScreen()` and `TryConsoleInput`. Subagent state is tracked separately in `readSubagents()`, but their permission dialogs are surfaced under the parent session's `needsPermission` flag via `permissionChecker.ts` polling the parent PID.

### Windows-Only

The entire detection and injection system is guarded by `IS_WINDOWS` / `process.platform !== 'win32'` checks. On macOS/Linux, `startPermissionChecker()` returns `undefined`, `readScreen()` returns `null`, and `approvePermission()` is a no-op. No permission UI is shown on non-Windows platforms.

---

## 6. Debugging Checklist

### "Permission Not Detected" — the UI never shows a prompt

1. **Confirm the server is on Windows.** The checker is disabled on all other platforms.

2. **Check the polling is running.** Look for `[inject-debug]` or `[injector stderr]` lines in the server log. The daemon should start on first use. If absent, check that `inject.ps1` exists at `packages/server/inject.ps1` and that `powershell.exe` is in PATH.

3. **Test `readScreen` manually.** Send a read command to the daemon:
   ```bash
   curl -X POST http://localhost:3000/api/sessions/<sessionId>/inject \
     -H "Content-Type: application/json" \
     -d '{"text":""}'
   ```
   (A blank text inject will show in the server log whether the daemon resolved the session PID.)

4. **Run `test-permission-inject.ps1` read-only.** The script calls `ReadScreen()` and prints the terminal content. If it returns null, `AttachConsole` is failing — this can happen if the target process is running in a session with restricted console access (e.g. a service).

5. **Check the patterns.** Open the actual terminal showing the dialog and verify the text contains "do you want to" and either "esc to cancel" or "allow ... for this session". If Claude changed its prompt wording, update `SECONDARY_PATTERNS` in `permissionChecker.ts:10–13`.

6. **Check for idle state.** `permissionChecker.ts:77` skips `idle` sessions. If the session is incorrectly classified as idle (PID check racing), the screen is never polled.

7. **Increase screen lines.** `readScreen` requests 25 lines (`consoleInjector.ts:138`). If the dialog is rendered further up in a tall terminal, increase this value.

### "Yes Click Does Nothing" — inject fires but dialog stays

1. **Check server logs for `[approve]` lines.** The endpoint logs:
   ```
   [approve] sessionId=<id> pid=<n> needsPermission=true text="\r"
   [approve] injectText done pid=<n>
   ```
   If `injectText done` appears but the dialog persists, injection reached the daemon but keys were not consumed.

2. **Check `[inject-debug]` in stderr.**
   - `pipe=-5` → normal for IntelliJ/ConPTY, fall through to `TryConsoleInput`.
   - `console=0` → `TryConsoleInput` succeeded. If dialog still shows, the key sequence may be wrong.
   - `console!=0` → `TryConsoleInput` failed. Common non-zero codes: `5` = access denied (elevated process), `6` = invalid handle.

3. **Verify the PID is the Claude process, not a wrapper.** In IntelliJ, the session file's PID is usually the `node` process running Claude. If `AttachConsole` fails (code 6), the PID may be a shell wrapper rather than the process that owns the console. Look at `[inject-debug] pid=X` and verify with Task Manager.

4. **Test arrow key delivery.** For "Yes, allow this session" (`\x1b[B\r`), the down-arrow must be delivered with `ENHANCED_KEY` (0x100). Run `test-permission-inject.ps1 <PID> $'\x1b[B\r'` and check if the selection moves in the terminal. If not, the ENHANCED_KEY flag may not be respected by the target terminal.

5. **ESC not working?** Confirm the text sent is exactly `\x1b` (one byte, 0x1B). If there's a trailing `\r`, ConPTY may interpret it as two separate inputs. The `TryConsoleInput` guard at inject.ps1:277 handles this: `text == "\x1b"` keeps it as-is.

6. **Check for suppress window falsely active.** If `permissionApprovedAt` is set but the window hasn't expired, `setNeedsPermission(true)` is silently ignored. A stale suppress window could happen if the server was restarted and the state was reconstructed. The suppress window is in-memory only — a server restart clears it.

---

## 7. Testing

### Running `test-permission-inject.ps1`

Located at `packages/server/test-permission-inject.ps1`.

```powershell
# Auto-discover first Claude process and inject "1"
powershell -ExecutionPolicy Bypass -File packages/server/test-permission-inject.ps1

# Specific PID, inject "1" (press 1, then Enter)
powershell -ExecutionPolicy Bypass -File packages/server/test-permission-inject.ps1 1220

# Specific PID, inject "3" (No option)
powershell -ExecutionPolicy Bypass -File packages/server/test-permission-inject.ps1 1220 "3"
```

The script:
1. Reads the screen **before** injection and prints it.
2. Calls `Inject(pid, text)` and prints the result string.
3. Waits 2 seconds.
4. Reads the screen **after** injection.
5. Reports PASS if screen content changed, FAIL if unchanged.

**Note:** This script uses its own embedded C# class (`PermissionInject`), not the production `PipeInjector` from `inject.ps1`. It is a standalone diagnostic tool.

### Testing Injection via curl

With the server running (`npm run dev`), find a session ID from the WebSocket snapshot, then:

```bash
# Send Enter (Yes)
curl -s -X POST http://localhost:3000/api/sessions/<sessionId>/inject \
  -H "Content-Type: application/json" \
  -d '{"text":"\r"}'

# Send Arrow-Down + Enter (Yes, allow this session)
curl -s -X POST http://localhost:3000/api/sessions/<sessionId>/inject \
  -H "Content-Type: application/json" \
  -d '{"text":"\u001b[B\r"}'

# Send ESC (No)
curl -s -X POST http://localhost:3000/api/sessions/<sessionId>/inject \
  -H "Content-Type: application/json" \
  -d '{"text":"\u001b"}'
```

Expected success response: `{"ok":true}`

Check server stderr for `[inject-debug]` lines to see which injection method was used and its result code.

### Manually Triggering Detection

To test detection without waiting for a real permission dialog:

1. Open a Claude session.
2. In the terminal, type a string that matches both patterns, e.g.:
   ```
   Do you want to allow this?  (ESC to cancel)
   ```
3. Within 3 seconds, the Overlord UI should show the `<PermissionPrompt>` component for that session.

**Note:** The text must appear in the last 25 lines of the screen buffer. Claude prompts are always at the bottom of the terminal, so this should match naturally.

### Checking `needsPermission` State via WebSocket

Connect to `ws://localhost:3000` and parse the `OfficeSnapshot`. The `session.needsPermission` and `session.permissionPromptText` fields are included in every snapshot broadcast. A simple test client:

```javascript
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (e) => {
  const snap = JSON.parse(e.data);
  if (snap.type === 'snapshot') {
    for (const room of snap.rooms) {
      for (const session of room.sessions) {
        if (session.needsPermission) {
          console.log('Permission needed:', session.sessionId, session.permissionPromptText);
        }
      }
    }
  }
};
```
