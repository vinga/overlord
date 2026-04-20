import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.js';
import type { StateManager } from '../session/stateManager.js';
import { feedCompactDetector, clearCompactDetector } from './compactDetect.js';
import { appendOutput as appendShellHistory } from './shellHistoryLog.js';
import { detectModeFromText } from '../session/modeDetect.js';

export interface PtyEventsContext {
  ptyManager: PtyManager;
  stateManager: StateManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ovrToPty: Map<string, string>;   // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;   // ptySessionId → ovrId
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws?: WebSocket; timestamp: number }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  PTY_BUFFER_MAX_CHUNKS: number;
  broadcastRaw: (msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
}

// Rolling stripped-text buffer for active-state detection (status bar + spinner line).
const activeDetectBuf = new Map<string, string>();
const ACTIVE_DETECT_BUF_SIZE = 2048;
// Last permission mode detected per ptySessionId. Used to clear the rolling buffer
// on transition so stale status-bar bytes in the tail cannot re-win.
const lastDetectedMode = new Map<string, string>();

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

    // Buffer output under ptySessionId while alive; migrated to ovrId on exit
    let buf = ctx.ptyOutputBuffer.get(ptySessionId);
    if (!buf) { buf = []; ctx.ptyOutputBuffer.set(ptySessionId, buf); }

    const isRepaint = data.includes('\x1b[?2026h');
    if (isRepaint) {
      buf = [];
      ctx.ptyOutputBuffer.set(ptySessionId, buf);
      // Repaint redraws the full terminal state — stale partial text in the compact
      // detect buffer would combine with new chunks and cause false positives.
      clearCompactDetector(ptySessionId);
      activeDetectBuf.delete(ptySessionId);
    }

    buf.push(Buffer.from(data));
    if (buf.length > ctx.PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - ctx.PTY_BUFFER_MAX_CHUNKS);

    const encoded = Buffer.from(data).toString('base64');
    // Broadcast using ovrId as sessionId so clients keyed by ovrId receive it
    ctx.broadcastRaw({ type: 'terminal:output', sessionId: ovrId, data: encoded });
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
    // Clean up any pending PID entry for this PTY session
    for (const [pid, entry] of ctx.pendingPtyByPid) {
      if (entry.ptySessionId === ptySessionId) {
        ctx.pendingPtyByPid.delete(pid);
        break;
      }
    }
    // Clean up any pending resume entry for this PTY session
    for (const [resumeId, entry] of ctx.pendingPtyByResumeId) {
      if (entry.ptySessionId === ptySessionId) {
        ctx.pendingPtyByResumeId.delete(resumeId);
        break;
      }
    }
    clearCompactDetector(ptySessionId);
    activeDetectBuf.delete(ptySessionId);
    lastDetectedMode.delete(ptySessionId);

    // Resolve ovrId before cleaning maps (client tracks by ovrId, not pty ID)
    const ovrId = ctx.ptyToOvr.get(ptySessionId) ?? ptySessionId;
    ctx.ptyToOvr.delete(ptySessionId);
    if (ctx.ovrToPty.get(ovrId) === ptySessionId) {
      ctx.ovrToPty.delete(ovrId);
    }

    // Migrate output buffer from ptyId → ovrId so the last repaint stays
    // accessible after the PTY mapping is cleaned up (terminal:replay for closed sessions).
    if (ovrId !== ptySessionId) {
      const buf = ctx.ptyOutputBuffer.get(ptySessionId);
      if (buf && buf.length > 0) {
        ctx.ptyOutputBuffer.set(ovrId, buf);
      }
    }
    ctx.ptyOutputBuffer.delete(ptySessionId);

    // Broadcast exit to all clients so any tab can update its state
    ctx.broadcastRaw({ type: 'terminal:exit', sessionId: ovrId, code });
    console.log(`[pty:exit] ptyId=${ptySessionId.slice(0, 12)} ovrId=${ovrId} code=${code}`);

    // Clean up wsSessionMap entries
    for (const [, sessions] of ctx.wsSessionMap) {
      sessions.delete(ptySessionId);
      sessions.delete(ovrId);
    }

    // Raw shell sessions: mark as historyOnly closed so the user can still view
    // the scrollback and click "Restart shell". Log file on disk is the source
    // of truth; it gets deleted only on explicit session delete or TTL sweep.
    const exitedSession = ctx.stateManager.getSession(ovrId);
    if (exitedSession?.sessionType === 'raw') {
      ctx.stateManager.markClosed(ovrId);
      ctx.stateManager.setHistoryOnly?.(ovrId, true);
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
    ctx.pendingPtyByPid.set(pid, { ptySessionId, ws: (ownerWs ?? null) as unknown as WebSocket });
  });
}
