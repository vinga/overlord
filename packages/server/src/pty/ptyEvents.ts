import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.js';

export interface PtyEventsContext {
  ptyManager: PtyManager;
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
  ctx.ptyManager.on('output', (sessionId: string, data: string) => {
    // Buffer output for replay on reconnect
    let buf = ctx.ptyOutputBuffer.get(sessionId);
    if (!buf) { buf = []; ctx.ptyOutputBuffer.set(sessionId, buf); }
    buf.push(Buffer.from(data));
    if (buf.length > ctx.PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - ctx.PTY_BUFFER_MAX_CHUNKS);

    const effectiveId = ctx.ptyToClaudeId.get(sessionId) ?? sessionId;
    const encoded = Buffer.from(data).toString('base64');
    ctx.broadcastRaw({ type: 'terminal:output', sessionId: effectiveId, data: encoded });
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
    // Clean up PTY output buffer
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
