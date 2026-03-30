# ConPTY Permission Injection — Investigation Notes

## Background

When Claude Code sessions run inside IntelliJ (or other IDE terminals), they use Windows ConPTY (Pseudo Console). This changes how keyboard input must be injected to interact with permission dialogs.

## What Works

- **`WriteConsoleInput` to `CONIN$` with `KEY_EVENT` records**: Works for ConPTY sessions when the records are correctly formed.
- **Plain `Enter` (`VK_RETURN`, scan 28)**: Confirmed working. Sends `\r` to the app, confirming the already-selected dialog option.
- **Arrow keys (`VK_DOWN`/`VK_UP`) with `ENHANCED_KEY = 0x100`**: Required flag in `dwControlKeyState` for ConPTY to recognize directional keys. Without it, arrow keys are silently ignored.
- **Escape (`VK_ESCAPE`, scan 1)**: Works when sent alone (no trailing `\r`). Cancels the dialog per the "Esc to cancel" hint.

## What Does NOT Work

- **`WriteFile` to stdin pipe (TryPipeInject)**: Fails with error -5 (`stdinObjects.Count == 0`) for ConPTY sessions because the app's stdin handle is `FILE_TYPE_CHAR` (not `FILE_TYPE_PIPE`). No writable pipe end is found.
- **`PostMessage WM_CHAR` to IntelliJ window**: Routes to IntelliJ's main HWND, not to the terminal pane hosting Claude.
- **Digit keys (e.g. `"1\r"`)**: Sending the option number + Enter fails. Inquirer.js either ignores the digit or enters a filter/search mode that prevents subsequent Enter from confirming.

## Permission Dialog Input Mapping

The Claude Code permission dialog (shown by `@inquirer/prompts` or similar):

```
 Do you want to proceed?
 ● 1. Yes
   2. Yes, allow <action> during this session
   3. No

 Esc to cancel · Tab to amend
```

Option 1 is **pre-selected** by default. The correct key sequences are:

| Button | Key Sequence | Encoded Text |
|--------|-------------|--------------|
| Yes (option 1) | Enter | `\r` |
| Yes, allow this session (option 2) | ↓ + Enter | `\x1b[B\r` |
| No (option 3) | Escape | `\x1b` |

## Key Details

### ENHANCED_KEY Flag
Arrow keys on a standard keyboard set bit `0x100` (`ENHANCED_KEY`) in `dwControlKeyState`. Without this flag, ConPTY's conhost ignores the `VK_DOWN`/`VK_UP` events entirely.

```csharp
recs[i].dwControlKeyState = 0x100; // required for arrow keys
```

### No Trailing \r for Escape
When `\x1b` (ESC) is followed by `\r` in the input buffer, terminal libraries may misinterpret the combination as an escape sequence rather than a bare ESC. Always send Escape without a trailing Enter.

### VT Sequence Encoding
The injection layer accepts VT-like escape sequences in the text string and translates them to `KEY_EVENT` records:

| VT Sequence | VK Code | Scan | ENHANCED_KEY |
|------------|---------|------|------|
| `\x1b[A` | 0x26 (VK_UP) | 0x48 | ✓ |
| `\x1b[B` | 0x28 (VK_DOWN) | 0x50 | ✓ |
| `\x1b[C` | 0x27 (VK_RIGHT) | 0x4D | ✓ |
| `\x1b[D` | 0x25 (VK_LEFT) | 0x4B | ✓ |
| `\x1b` | 0x1B (VK_ESCAPE) | 0x01 | ✗ |
| `\r` | 0x0D (VK_RETURN) | 0x1C | ✗ |

## Architecture

```
UI Click (Yes/No)
  → HTTP POST /api/sessions/{id}/inject  {text: "\r"}
  → Node.js: injectText(pid, text)
  → consoleInjector.ts: JSON over stdin pipe → inject.ps1 daemon
  → inject.ps1: TryPipeInject fails (-5) → TryConsoleInput
  → TryConsoleInput: FreeConsole → AttachConsole(pid) → CreateFile("CONIN$") → WriteConsoleInput
  → ConPTY: translates KEY_EVENTs → VT sequences → app stdin
  → Claude Code: Inquirer.js processes key → dialog dismissed
```

## Test Script

`packages/server/test-permission-inject.ps1` — standalone backend test that reads screen before/after injection.
Usage: `powershell -ExecutionPolicy Bypass -File test-permission-inject.ps1 <PID> "<text>"`
