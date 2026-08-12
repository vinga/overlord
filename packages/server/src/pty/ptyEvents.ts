import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.js';
import type { StateManager } from '../session/stateManager.js';
import { feedCompactDetector, clearCompactDetector } from './compactDetect.js';
import { appendOutput as appendShellHistory } from './shellHistoryLog.js';
import { detectModeFromText } from '../session/modeDetect.js';
import { feedGrid, migrateGrid, disposeGrid, readGridText } from './screenGrid.js';
import { scheduleInject, shouldUseExtraEnter } from './injectScheduler.js';

// Output-gated initial-prompt injection.
//
// A freshly spawned Claude TUI streams startup output well before its input
// box is interactive; injecting on the first chunk drops the text. Rather than
// wait a blind fixed delay, we ARM the queued prompt on first output and fire
// it as soon as the input box actually renders — detected from the
// `(shift+tab to cycle)` status-bar sentinel that paints together with the box
// (see `sentinelFound` in the output handler below). A fallback timer caps the
// wait so detection misses or exotic terminals never hang the prompt.
const INITIAL_PROMPT_MAX_WAIT_MS = 1500; // fallback if the sentinel never appears (== legacy fixed delay)
const INITIAL_PROMPT_SETTLE_MS = 150;    // brief settle after the box paints before writing

interface ArmedPrompt {
  text: string;
  extraEnter: boolean;
  fallbackTimer: ReturnType<typeof setTimeout>;
  fired: boolean;
}

// Armed-but-not-yet-fired initial prompts, keyed by ptySessionId. Entries exist
// only during the brief spawn→first-render window, so the hot output path gates
// every access on `armedInitialPrompts.size > 0` and stays a no-op afterwards.
const armedInitialPrompts = new Map<string, ArmedPrompt>();

function disarmInitialPrompt(ptySessionId: string): void {
  const armed = armedInitialPrompts.get(ptySessionId);
  if (!armed) return;
  clearTimeout(armed.fallbackTimer);
  armedInitialPrompts.delete(ptySessionId);
}

// Inject the armed prompt now. Idempotent via the `fired` guard so the
// sentinel-triggered fire and the fallback timer can never double-inject.
function injectArmedPrompt(ctx: PtyEventsContext, ptySessionId: string, reason: string): void {
  const armed = armedInitialPrompts.get(ptySessionId);
  if (!armed || armed.fired) return;
  armed.fired = true;
  clearTimeout(armed.fallbackTimer);
  armedInitialPrompts.delete(ptySessionId);

  if (!ctx.ptyManager.has(ptySessionId)) {
    console.warn(`[spawn:inject] pty gone before inject pty=${ptySessionId.slice(0, 16)}`);
    return;
  }
  console.log(`[spawn:inject] writing initial prompt to pty=${ptySessionId.slice(0, 16)} via=${reason}`);
  const write = (data: string): boolean => {
    try { return ctx.ptyManager.write(ptySessionId, data); } catch { return false; }
  };
  scheduleInject(
    write,
    () => ctx.ptyManager.has(ptySessionId),
    () => console.warn(`[spawn:inject] initial prompt write failed pty=${ptySessionId.slice(0, 12)}`),
    armed.text,
    armed.extraEnter,
  );
}

// Arm a queued prompt on the freshly spawned PTY's first output. Fires later
// from the output handler when the input box renders, or from the fallback
// timer at INITIAL_PROMPT_MAX_WAIT_MS — whichever comes first.
function armInitialPrompt(ctx: PtyEventsContext, ptySessionId: string, text: string): void {
  const extraEnter = shouldUseExtraEnter(text);
  console.log(`[spawn:inject] armed initial prompt for pty=${ptySessionId.slice(0, 16)} maxWait=${INITIAL_PROMPT_MAX_WAIT_MS}ms len=${text.length}`);
  const fallbackTimer = setTimeout(() => injectArmedPrompt(ctx, ptySessionId, 'fallback'), INITIAL_PROMPT_MAX_WAIT_MS);
  armedInitialPrompts.set(ptySessionId, { text, extraEnter, fallbackTimer, fired: false });
}

export interface PtyEventsContext {
  ptyManager: PtyManager;
  stateManager: StateManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ovrToPty: Map<string, string>;   // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;   // ptySessionId → ovrId
  linkageTracker: import('../session/ptyLinkageTracker.js').PtyLinkageTracker;
  ptyOutputBuffer: Map<string, Buffer[]>;
  PTY_BUFFER_MAX_CHUNKS: number;
  broadcastRaw: (msg: object) => void;
  broadcastTerminalOutput: (termId: string, msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
}

// Rolling stripped-text buffer for active-state detection (status bar + spinner line).
const activeDetectBuf = new Map<string, string>();
const ACTIVE_DETECT_BUF_SIZE = 2048;
// Last permission mode detected per ptySessionId. Used to clear the rolling buffer
// on transition so stale status-bar bytes in the tail cannot re-win.
const lastDetectedMode = new Map<string, string>();

// Tiny raw-output tail per ptySessionId so the "Unknown command" substring gate
// still fires when the phrase is split across two chunks. Sized > the sentinel.
const unknownCmdCarry = new Map<string, string>();
const UNKNOWN_CMD_SENTINEL = 'Unknown command';
const UNKNOWN_CMD_CARRY = 24;

// Single-pass ANSI/control strip. Replaces 5 sequential regex passes on every
// PTY output chunk — those were dominating the event loop during streaming.
// Emits printable ASCII + \n\t\r; collapses Unicode whitespace to space;
// skips all ESC-introduced control sequences (CSI, OSC, and lone/intermediate).
function stripForStatusScan(s: string): string {
  let out = '';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      // ESC — consume the control sequence.
      if (i + 1 >= n) break;
      const next = s.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: ESC [ ... final (0x40-0x7e)
        i += 2;
        while (i < n) {
          const cc = s.charCodeAt(i);
          if (cc >= 0x40 && cc <= 0x7e) break;
          i++;
        }
      } else if (next === 0x5d) {
        // OSC: ESC ] ... ST (ESC \) or BEL
        i += 2;
        while (i < n) {
          const cc = s.charCodeAt(i);
          if (cc === 0x07) break;
          if (cc === 0x1b && i + 1 < n && s.charCodeAt(i + 1) === 0x5c) { i++; break; }
          i++;
        }
      } else {
        // Other ESC-introduced single-char sequence: consume the next char.
        i += 1;
      }
      continue;
    }
    // Printable ASCII + \n\t\r pass through unchanged.
    if ((c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x09 || c === 0x0d) {
      out += s[i];
      continue;
    }
    // Unicode whitespace (e.g. NBSP U+00A0) collapsed to space so the
    // "(shift+tab to cycle)" sentinel survives.
    if (c === 0xa0 || c === 0x2007 || c === 0x202f || c === 0x3000) { out += ' '; continue; }
    // Everything else (other controls, non-ASCII) becomes space if it's
    // whitespace-class, else dropped. Matches the prior behavior of the
    // Unicode-aware replacer.
    if (c >= 0x2000 && c <= 0x200b) { out += ' '; continue; }
    // Drop silently.
  }
  return out;
}

/**
 * Flush the last detected permission mode for a PTY to a freshly linked ovrId.
 * Called by linkPtyToOvr after ptyToOvr is set so the startup race (PTY output
 * arrives before linking) doesn't silently discard mode detections.
 */
export function applyPendingPermMode(
  ptySessionId: string,
  ovrId: string,
  stateManager: { setPermissionMode: (id: string, mode: string) => void },
): void {
  const mode = lastDetectedMode.get(ptySessionId);
  if (mode) stateManager.setPermissionMode(ovrId, mode);
}

export function wirePtyEvents(ctx: PtyEventsContext): void {
  ctx.ptyManager.on('output', (ptySessionId: string, data: string) => {
    // Resolve ovrId for this PTY (set after linking; fall back to ptyId before link)
    const ovrId = ctx.ptyToOvr.get(ptySessionId) ?? ptySessionId;

    // Fire a queued initial prompt once the freshly spawned PTY produces output
    // (TUI started rendering). takePendingInitialPrompt is one-shot, so this
    // runs at most once per spawn; common case is a cheap empty-map lookup.
    const initialPrompt = ctx.stateManager.takePendingInitialPrompt(ptySessionId);
    if (initialPrompt) armInitialPrompt(ctx, ptySessionId, initialPrompt);

    // Buffer output under ptySessionId while alive; migrated to ovrId on exit
    let buf = ctx.ptyOutputBuffer.get(ptySessionId);
    if (!buf) { buf = []; ctx.ptyOutputBuffer.set(ptySessionId, buf); }

    // Screen-clear detection. This was `data.includes('\x1b[?2026h')` (BSU), which
    // the current Claude CLI never emits — so the resets below silently never ran.
    // `\x1b[2J` IS emitted (verified against a captured stream) and means the same
    // thing for these consumers: the screen was wiped, so partial text carried in
    // the detect buffers is now stale and would combine with new chunks into false
    // positives. The replay buffer is no longer reset here — replay reads the
    // screen grid, not this buffer (see terminal:replay in wsHandler).
    const isScreenClear = data.includes('\x1b[2J');
    if (isScreenClear) {
      clearCompactDetector(ptySessionId);
      activeDetectBuf.delete(ptySessionId);
      unknownCmdCarry.delete(ptySessionId);
    }

    buf.push(Buffer.from(data));
    if (buf.length > ctx.PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - ctx.PTY_BUFFER_MAX_CHUNKS);

    // Feed the headless VT emulator so getScreenText can read a real rendered grid
    // (in-memory only — no renderer; bounded scrollback; read happens off the 3s cycle).
    feedGrid(ptySessionId, data);

    // Detect "Unknown command: /x" — Claude Code prints this only to the screen
    // (never the transcript) when the user types a slash command / skill that
    // doesn't exist, so a poll-free stream detector is the only way to catch it.
    // Cheap substring gate on the raw chunk (+ tiny carry to survive a chunk
    // split mid-phrase); only on a hit do we read the clean, ANSI-stripped grid
    // (just written above) and extract the command. Rare event → the grid read
    // essentially never runs on normal output.
    {
      const carry = unknownCmdCarry.get(ptySessionId) ?? '';
      if ((carry + data).includes(UNKNOWN_CMD_SENTINEL)) {
        const grid = readGridText(ptySessionId);
        if (grid) {
          const re = /Unknown command:\s*(\/\S+)/gi;
          let cmd: string | undefined;
          for (let m = re.exec(grid); m; m = re.exec(grid)) cmd = m[1]; // last match = most recent
          if (cmd) ctx.stateManager.setUnknownCommand(ovrId, cmd);
        }
      }
      unknownCmdCarry.set(ptySessionId, data.slice(-UNKNOWN_CMD_CARRY));
    }

    const encoded = Buffer.from(data).toString('base64');
    // Send using ovrId as sessionId so clients keyed by ovrId receive it —
    // only to clients subscribed to this terminal.
    ctx.broadcastTerminalOutput(ovrId, { type: 'terminal:output', sessionId: ovrId, data: encoded });
    ctx.stateManager.setPtyActive(ovrId);

    // Tee raw-shell output to disk for history persistence across restarts.
    const sess = ctx.stateManager.getSession(ovrId);
    if (sess?.sessionType === 'raw') {
      appendShellHistory(ovrId, Buffer.from(data));
    }

    // Detect "Compacting conversation" in PTY output — set isCompacting immediately,
    // before the compact_boundary event lands in the transcript.
    feedCompactDetector(ptySessionId, data, (line) => {
      ctx.stateManager.addPtyCompact(ovrId, line);
    });

    // Detect active state (status bar "esc to interrupt" / spinner line)
    // so the UI flips from 'waiting' → 'working' without waiting for the next
    // transcript write. Mirrors the bridge-side logic in index.ts.
    //
    // Hot path: gate on cheap substring hints before the expensive ANSI strip +
    // regex scan. The status bar carries distinctive ASCII keywords; chunks
    // without any of them (or a pending rolling buffer) cannot change detection.
    {
      const prev = activeDetectBuf.get(ptySessionId) ?? '';
      const needsScan =
        prev.length > 0 ||
        data.indexOf('shift') !== -1 ||
        data.indexOf('interrupt') !== -1 ||
        data.indexOf('mode on') !== -1;

      if (needsScan) {
        const stripped = stripForStatusScan(data);
        const combined = (prev + stripped).slice(-ACTIVE_DETECT_BUF_SIZE);
        activeDetectBuf.set(ptySessionId, combined);

        const tailLines = combined.split('\n');
        let activeSignal: boolean | null = null;
        for (let i = tailLines.length - 1; i >= 0; i--) {
          const line = tailLines[i];
          if (/\(shift\+tab to cycle\)/i.test(line)) {
            activeSignal = /esc to interrupt/i.test(line);
            break;
          }
          if (/[·*·]\s+\w+[.\u2026]+\s*\(\d/.test(line)) {
            activeSignal = true;
            break;
          }
        }
        if (activeSignal === true) ctx.stateManager.setBridgeActive(ovrId, true);
        else if (activeSignal === false) ctx.stateManager.setBridgeActive(ovrId, false);

        // Detect permission mode on every data event using the rolling buffer.
        // Shift+Tab rewrites the status bar but may not emit a BSU repaint marker,
        // so gating this on isRepaint alone delays the pill update by hundreds of ms.
        const { sentinelFound, mode } = detectModeFromText(combined);
        // The status-bar sentinel paints together with the input box, so its first
        // appearance is the earliest safe moment to write a queued initial prompt.
        // injectArmedPrompt is idempotent, so later sentinels are cheap no-ops.
        if (sentinelFound && armedInitialPrompts.size > 0 && armedInitialPrompts.has(ptySessionId)) {
          setTimeout(() => injectArmedPrompt(ctx, ptySessionId, 'sentinel'), INITIAL_PROMPT_SETTLE_MS).unref?.();
        }
        if (sentinelFound) {
          const resolvedMode = mode ?? 'default';
          const prevMode = lastDetectedMode.get(ptySessionId);
          if (prevMode !== resolvedMode) {
            lastDetectedMode.set(ptySessionId, resolvedMode);
            // Drop the rolling buffer so the next chunk starts clean — prevents
            // stale earlier status-bar text from winning over the new one.
            activeDetectBuf.delete(ptySessionId);
          }
          ctx.stateManager.setPermissionMode(ovrId, resolvedMode);
        }
      }
    }
  });

  ctx.ptyManager.on('exit', (ptySessionId: string, code: number) => {
    disarmInitialPrompt(ptySessionId);
    ctx.linkageTracker.removePidEntriesByPty(ptySessionId);
    ctx.linkageTracker.removeResumeEntriesByPty(ptySessionId);
    clearCompactDetector(ptySessionId);
    activeDetectBuf.delete(ptySessionId);
    lastDetectedMode.delete(ptySessionId);
    unknownCmdCarry.delete(ptySessionId);

    // Resolve ovrId before cleaning maps (client tracks by ovrId, not pty ID)
    const ovrId = ctx.ptyToOvr.get(ptySessionId) ?? ptySessionId;
    ctx.ptyToOvr.delete(ptySessionId);
    const wasOwner = ctx.ovrToPty.get(ovrId) === ptySessionId;
    if (wasOwner) {
      ctx.ovrToPty.delete(ovrId);
    }
    // Superseded: a DIFFERENT, still-live PTY already owns this ovr (concurrent
    // --resume kills the old claude to free the session lock, then re-links; or
    // compaction relinks the same ovr to a new PTY). The exiting PTY is stale —
    // broadcasting terminal:exit for ovrId here would flip the client to
    // "Session exited" even though the live PTY is fine, leaving the user unable
    // to use a session whose backend is alive. Suppress the exit signal and the
    // grid/buffer migration in that case; only tear down this PTY's own state.
    const superseded = !wasOwner && ctx.ovrToPty.has(ovrId);

    if (superseded) {
      ctx.ptyOutputBuffer.delete(ptySessionId);
      disposeGrid(ptySessionId);
      console.log(`[pty:exit] ptyId=${ptySessionId.slice(0, 12)} ovrId=${ovrId} code=${code} (superseded — exit suppressed)`);
      // Don't broadcast terminal:exit and don't touch the live owner's wsSessionMap entry.
      for (const [, sessions] of ctx.wsSessionMap) sessions.delete(ptySessionId);
      return;
    }

    // Migrate output buffer from ptyId → ovrId so the last repaint stays
    // accessible after the PTY mapping is cleaned up (terminal:replay for closed sessions).
    // A superseded pty must not overwrite the live new pty's scrollback.
    if (ovrId !== ptySessionId) {
      const buf = ctx.ptyOutputBuffer.get(ptySessionId);
      if (buf && buf.length > 0) {
        ctx.ptyOutputBuffer.set(ovrId, buf);
      }
    }
    ctx.ptyOutputBuffer.delete(ptySessionId);

    // Mirror for the screen grid: hand the final rendered screen to ovrId, then
    // dispose it shortly after so a closed-session read still works briefly without
    // leaking emulators. disposeGrid(ptySessionId) is a no-op once migrated.
    migrateGrid(ptySessionId, ovrId);
    disposeGrid(ptySessionId);
    if (ovrId !== ptySessionId) {
      setTimeout(() => disposeGrid(ovrId), 30_000).unref?.();
    }

    // Broadcast exit to all clients so any tab can update its state
    ctx.broadcastRaw({ type: 'terminal:exit', sessionId: ovrId, code });
    console.log(`[pty:exit] ptyId=${ptySessionId.slice(0, 12)} ovrId=${ovrId} code=${code}`);

    // Raw shell sessions: mark as historyOnly closed so the user can still view
    // the scrollback and click "Restart shell". Log file on disk is the source
    // of truth; it gets deleted only on explicit session delete or TTL sweep.
    const exitedSession = ctx.stateManager.getSession(ovrId);
    if (exitedSession?.sessionType === 'raw') {
      ctx.stateManager.markClosed(ovrId);
      ctx.stateManager.setHistoryOnly?.(ovrId, true);
    } else if (exitedSession?.provider === 'opencode' || exitedSession?.provider === 'codex') {
      ctx.stateManager.markClosed(ovrId);
    }
  });

  ctx.ptyManager.on('error', (ptySessionId: string, message: string) => {
    const ovrId = ctx.ptyToOvr.get(ptySessionId) ?? ptySessionId;
    const msg = { type: 'terminal:error', sessionId: ovrId, message };
    for (const [ws, sessions] of ctx.wsSessionMap) {
      if (sessions.has(ptySessionId) || sessions.has(ovrId)) {
        ctx.sendToClient(ws, msg);
        break;
      }
    }
  });

  // Global PID-ready handler: populate pendingPtyByPid for ALL PTY spawns (new + resume + auto-resume)
  ctx.ptyManager.on('pid-ready', (ptySessionId: string, pid: number) => {
    if (!pid) return;
    // Find which ws owns this PTY session
    let ownerWs: WebSocket | null = null;
    for (const [ws, sessions] of ctx.wsSessionMap) {
      if (sessions.has(ptySessionId)) {
        ownerWs = ws;
        break;
      }
    }
    // Use null ws sentinel for auto-resume (broadcast to all clients)
    ctx.linkageTracker.trackPid(pid, { ptySessionId, ws: (ownerWs ?? null) as unknown as WebSocket });
  });
}
