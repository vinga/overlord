import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.js';
import type { StateManager } from '../session/stateManager.js';

export interface PtyEventsContext {
  ptyManager: PtyManager;
  stateManager: StateManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ptyToClaudeId: Map<string, string>;
  claudeToPtyId: Map<string, string>;
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws: WebSocket; timestamp: number }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  PTY_BUFFER_MAX_CHUNKS: number;
  broadcastRaw: (msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
}

export function wirePtyEvents(ctx: PtyEventsContext): void {
  // Wire PtyManager events → broadcast to ALL connected clients
  // so any tab can view the PTY terminal
  const PERM_MODE_PATTERNS: Array<{ pattern: RegExp; mode: string }> = [
    { pattern: /bypass permissions on/i, mode: 'bypassPermissions' },
    { pattern: /accept edits on/i, mode: 'acceptEdits' },
    { pattern: /plan mode on/i, mode: 'plan' },
  ];

  ctx.ptyManager.on('output', (sessionId: string, data: string) => {
    // Buffer output for replay on reconnect
    let buf = ctx.ptyOutputBuffer.get(sessionId);
    if (!buf) { buf = []; ctx.ptyOutputBuffer.set(sessionId, buf); }

    const isRepaint = data.includes('\x1b[?2026h');
    if (isRepaint) {
      buf = [];
      ctx.ptyOutputBuffer.set(sessionId, buf);
    }

    buf.push(Buffer.from(data));
    if (buf.length > ctx.PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - ctx.PTY_BUFFER_MAX_CHUNKS);

    const effectiveId = ctx.ptyToClaudeId.get(sessionId) ?? sessionId;
    const encoded = Buffer.from(data).toString('base64');
    ctx.broadcastRaw({ type: 'terminal:output', sessionId: effectiveId, data: encoded });

    // Detect "Compacting conversation" in PTY output — set isCompacting immediately,
    // before the compact_boundary event lands in the transcript.
    if (data.includes('Compacting conversation')) {
      // Strip ANSI escape codes to get clean text
      const cleanText = data
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
        .replace(/\x1b[^[\]]/g, '')
        .replace(/\x1b/g, '')
        .replace(/[^\x20-\x7e\n\t\r]/g, '');
      // Extract the compacting line (may include timing like "Compacting conversation… (2m 1s · ↑ 698 tokens)")
      const match = cleanText.match(/Compacting conversation[^\n]*/);
      const compactLine = match ? match[0].trim() : 'Compacting conversation…';
      ctx.stateManager.addPtyCompact(effectiveId, compactLine);
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
      // REVERT NOTE: original code guarded this with: if (resolvedMode !== current) { ... }
      // CHANGE: Always call setPermissionMode on repaint — even if mode unchanged — so the
      // lock gets refreshed for non-default modes, preventing permissionChecker
      // from flipping back to 'default' between repaints.
      ctx.stateManager.setPermissionMode(effectiveId, resolvedMode);
    }
  });

  ctx.ptyManager.on('exit', (sessionId: string, code: number) => {
    // Clean up any pending PID entry for this PTY session
    for (const [pid, entry] of ctx.pendingPtyByPid) {
      if (entry.ptySessionId === sessionId) {
        ctx.pendingPtyByPid.delete(pid);
        break;
      }
    }
    // Clean up any pending resume entry for this PTY session
    for (const [resumeId, entry] of ctx.pendingPtyByResumeId) {
      if (entry.ptySessionId === sessionId) {
        ctx.pendingPtyByResumeId.delete(resumeId);
        break;
      }
    }
    // Resolve the claude session ID before cleaning maps (client tracks by claude ID, not pty ID)
    const claudeId = ctx.ptyToClaudeId.get(sessionId);
    const effectiveId = claudeId ?? sessionId;
    ctx.ptyToClaudeId.delete(sessionId);
    // Clean up reverse map
    if (claudeId) {
      ctx.claudeToPtyId.delete(claudeId);
    } else {
      for (const [cId, pId] of ctx.claudeToPtyId) {
        if (pId === sessionId) { ctx.claudeToPtyId.delete(cId); break; }
      }
    }
    // Migrate output buffer from ptyId → claudeId so the last repaint stays
    // accessible after the PTY mapping is cleaned up (terminal:replay for closed sessions).
    if (claudeId) {
      const buf = ctx.ptyOutputBuffer.get(sessionId);
      if (buf && buf.length > 0) {
        ctx.ptyOutputBuffer.set(claudeId, buf);
      }
    }
    ctx.ptyOutputBuffer.delete(sessionId);
    // Broadcast exit to all clients so any tab can update its state
    ctx.broadcastRaw({ type: 'terminal:exit', sessionId: effectiveId, code });
    // Clean up wsSessionMap entries
    for (const [, sessions] of ctx.wsSessionMap) {
      sessions.delete(sessionId);
      sessions.delete(effectiveId);
    }
  });

  ctx.ptyManager.on('error', (sessionId: string, message: string) => {
    const msg = { type: 'terminal:error', sessionId, message };
    for (const [ws, sessions] of ctx.wsSessionMap) {
      if (sessions.has(sessionId)) {
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
