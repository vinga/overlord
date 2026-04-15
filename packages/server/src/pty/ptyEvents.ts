import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.js';
import type { StateManager } from '../session/stateManager.js';

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

// Rolling plain-text buffer per PTY session for cross-chunk pattern detection.
// Stores stripped text (no ANSI), capped at COMPACT_DETECT_BUF_SIZE chars.
const compactDetectBuf = new Map<string, string>();
const COMPACT_DETECT_BUF_SIZE = 500;

export function wirePtyEvents(ctx: PtyEventsContext): void {
  // Wire PtyManager events → broadcast to ALL connected clients
  // so any tab can view the PTY terminal
  const PERM_MODE_PATTERNS: Array<{ pattern: RegExp; mode: string }> = [
    { pattern: />>\s+bypass permissions on/i, mode: 'bypassPermissions' },
    { pattern: />>\s+accept edits on/i, mode: 'acceptEdits' },
    { pattern: />>\s+plan mode on/i, mode: 'plan' },
  ];

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
      compactDetectBuf.delete(ptySessionId);
    }

    buf.push(Buffer.from(data));
    if (buf.length > ctx.PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - ctx.PTY_BUFFER_MAX_CHUNKS);

    const encoded = Buffer.from(data).toString('base64');
    // Broadcast using ovrId as sessionId so clients keyed by ovrId receive it
    ctx.broadcastRaw({ type: 'terminal:output', sessionId: ovrId, data: encoded });
    ctx.stateManager.setPtyActive(ovrId);

    // Detect "Compacting conversation" in PTY output — set isCompacting immediately,
    // before the compact_boundary event lands in the transcript.
    // Use a rolling text buffer to handle the text arriving split across chunks.
    {
      const stripped = data
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
        .replace(/\x1b[^[\]]/g, '')
        .replace(/\x1b/g, '')
        .replace(/[^\x20-\x7e\n\t\r]/g, '');
      const prev = compactDetectBuf.get(ptySessionId) ?? '';
      const combined = (prev + stripped).slice(-COMPACT_DETECT_BUF_SIZE);
      compactDetectBuf.set(ptySessionId, combined);
      if (combined.includes('Compacting conversation')) {
        const match = combined.match(/Compacting conversation[^\n]*/);
        const compactLine = match ? match[0].trim() : 'Compacting conversation…';
        ctx.stateManager.addPtyCompact(ovrId, compactLine);
        // Clear buffer after detection to avoid duplicate triggers
        compactDetectBuf.set(ptySessionId, '');
      }
    }

    // On repaint, detect permission mode and update immediately
    if (isRepaint) {
      const text = data.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '').replace(/\x1b[^[\]]/g, '')
        .replace(/\x1b/g, '').replace(/[^\x20-\x7e\n\t\r]/g, '');
      let frameMode: string | undefined;
      for (const { pattern, mode } of PERM_MODE_PATTERNS) {
        if (pattern.test(text)) { frameMode = mode; break; }
      }
      const resolvedMode = frameMode ?? 'default';
      ctx.stateManager.setPermissionMode(ovrId, resolvedMode);
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
    compactDetectBuf.delete(ptySessionId);

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
