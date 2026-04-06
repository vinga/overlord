import type { WebSocket } from 'ws';
import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { AiClassifier } from '../ai/aiClassifier.js';
import type { SessionWatcher } from './sessionWatcher.js';
import { findTranscriptPathAnywhere } from './transcriptReader.js';
import { log } from '../logger.js';

export interface SessionEventContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  aiClassifier: AiClassifier;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ptyToClaudeId: Map<string, string>;
  claudeToPtyId: Map<string, string>;
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws: WebSocket; timestamp: number }>;
  pendingCloneInfo: Map<string, { name: string; originalSessionId: string }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  recentlyRemovedByCwd: Map<string, { sessionId: string; removedAt: number }>;
  broadcastRaw: (msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
  isStartupComplete: () => boolean;
  linkPendingBridge?: (sessionId: string, cwd: string, rawName?: string) => void;
}

// Helper: check if any PTY resume is currently in progress (pendingPtyByResumeId not yet consumed)
export function hasActiveResumeInProgress(ctx: SessionEventContext): boolean {
  return ctx.pendingPtyByResumeId.size > 0;
}

// Helper: close or remove a replaced session during /clear detection.
// If the old session has no own transcript, it's an empty shell — remove entirely.
// If it has a transcript, keep it as closed (it has conversation history worth preserving).
export function closeOrRemoveReplaced(ctx: SessionEventContext, oldSessionId: string): void {
  const hasTranscript = !!findTranscriptPathAnywhere(oldSessionId);
  if (hasTranscript) {
    ctx.stateManager.markClosed(oldSessionId);
  } else {
    ctx.stateManager.remove(oldSessionId);
    log('session:removed', 'Removed empty replaced session', { sessionId: oldSessionId, sessionName: oldSessionId.slice(0, 8) });
  }
}

// Migrate PTY routing maps when a session UUID changes (e.g. /clear)
// Tries by session ID first, then falls back to finding any PTY entry sharing the same PID.
export function migratePtyMaps(ctx: SessionEventContext, oldSessionId: string, newSessionId: string, pid?: number): void {
  let oldPtyId = ctx.claudeToPtyId.get(oldSessionId);
  if (!oldPtyId && pid && pid > 0) {
    for (const [claudeId, ptyId] of ctx.claudeToPtyId) {
      if (ctx.ptyManager.getPid(ptyId) === pid || ctx.stateManager.getSession(claudeId)?.pid === pid) {
        oldPtyId = ptyId;
        ctx.claudeToPtyId.delete(claudeId);
        break;
      }
    }
  }
  if (oldPtyId) {
    ctx.claudeToPtyId.set(newSessionId, oldPtyId);
    ctx.ptyToClaudeId.set(oldPtyId, newSessionId);
    ctx.stateManager.setSessionType(newSessionId, 'embedded');
    ctx.broadcastRaw({ type: 'terminal:session-replaced', oldSessionId, newSessionId });
  }
}

export function registerSessionEventHandlers(sessionWatcher: SessionWatcher, ctx: SessionEventContext): void {

  function applyPendingCloneInfo(ptySessionId: string, claudeSessionId: string): void {
    const info = ctx.pendingCloneInfo.get(ptySessionId);
    if (info) {
      ctx.pendingCloneInfo.delete(ptySessionId);
      const session = ctx.stateManager.getSession(claudeSessionId);
      if (session) {
        session.proposedName = info.name;
        session.resumedFrom = info.originalSessionId;
        ctx.stateManager.refreshTranscript(claudeSessionId);
      }
      log('info', `Applied clone info: name="${info.name}", resumedFrom=${info.originalSessionId.slice(0, 8)} → ${claudeSessionId.slice(0, 8)}`);
    }
  }

  sessionWatcher.on('added', (raw) => {
    // Skip interim session: claude --resume creates a temp UUID first, then settles to target ID.
    // If there's a pending PTY resume for this CWD and this is NOT the target ID, skip it —
    // but only if the interim has no transcript (safety: don't discard sessions with real data).
    const pendingResumeTarget = ctx.stateManager.getPendingResumeTarget(raw.cwd);
    if (pendingResumeTarget && raw.sessionId !== pendingResumeTarget && ctx.pendingPtyByResumeId.has(pendingResumeTarget)) {
      const interimTranscript = findTranscriptPathAnywhere(raw.sessionId);
      if (!interimTranscript) {
        console.log(`[session:skip-interim] ${raw.sessionId.slice(0, 8)} is interim for resume target ${pendingResumeTarget.slice(0, 8)}, skipping (no transcript)`);
        return;
      }
    }
    const { isNewWaiting, lastMessage } = ctx.stateManager.addOrUpdate(raw);
    if (isNewWaiting && lastMessage && raw.kind !== 'haiku-worker') void ctx.aiClassifier.classifyCompletion(raw.sessionId, lastMessage);
    // Log session creation
    const createdName = raw.proposedName ?? raw.sessionId.slice(0, 8);
    log('session:created', 'Session created', { sessionId: raw.sessionId, sessionName: createdName, extra: `PID ${raw.pid} name=${raw.name ?? 'NONE'}` });
    // Link PTY by embedded marker in session name (works for spawn, resume, and clone)
    let linkedToPty = false;
    if (raw.name && raw.name.includes('___OVR:')) {
      const marker = raw.name.split('___OVR:')[1];
      const ptyAlive = ctx.ptyManager.has(marker);
      console.log(`[marker-check] added: marker=${marker} ptyAlive=${ptyAlive}`);
      if (marker && ptyAlive) {
        linkedToPty = true;
        ctx.ptyToClaudeId.set(marker, raw.sessionId);
        ctx.claudeToPtyId.set(raw.sessionId, marker);
        // Find the WS that owns this PTY
        let ownerWs: WebSocket | null = null;
        for (const [ws, sessions] of ctx.wsSessionMap) {
          if (sessions.has(marker)) {
            ownerWs = ws;
            break;
          }
        }
        if (ownerWs) {
          const wsSessions = ctx.wsSessionMap.get(ownerWs);
          if (wsSessions) wsSessions.add(raw.sessionId);
          ctx.sendToClient(ownerWs, { type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
        } else {
          for (const sessions of ctx.wsSessionMap.values()) {
            sessions.add(raw.sessionId);
          }
          ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
        }
        ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
        const ptyPid = ctx.ptyManager.getPid(marker);
        if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
        applyPendingCloneInfo(marker, raw.sessionId);
        log('pty:started', 'PTY clone linked via name marker', { sessionId: raw.sessionId });
      }
    }
    // Link PTY session to real Claude session by PID
    if (!linkedToPty && raw.pid && ctx.pendingPtyByPid.has(raw.pid)) {
      const entry = ctx.pendingPtyByPid.get(raw.pid)!;
      ctx.pendingPtyByPid.delete(raw.pid);
      linkedToPty = true;
      // Set up ID mapping so output is rerouted from pty-xxx to real claudeSessionId
      ctx.ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
      ctx.claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      if (entry.ws) {
        // Normal spawn: link to the owning WS client
        const wsSessions = ctx.wsSessionMap.get(entry.ws);
        if (wsSessions) wsSessions.add(raw.sessionId);
        ctx.sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      } else {
        // Auto-resume: broadcast linked event to all clients, migrate all wsSessionMap entries
        for (const sessions of ctx.wsSessionMap.values()) {
          sessions.add(raw.sessionId);
        }
        ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      }
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      // Update the session's PID to the PTY process PID so ProcessChecker doesn't mark it closed
      const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
      if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
      const ptySessionName = ctx.stateManager.getSession(raw.sessionId)?.proposedName ?? raw.proposedName ?? raw.sessionId.slice(0, 8);
      log('pty:started', 'PTY session started', { sessionId: raw.sessionId, sessionName: ptySessionName });
    } else if (raw.pid && !ctx.pendingPtyByPid.has(raw.pid) && ctx.stateManager.hasPendingResume(raw.cwd)) {
      // PID not in pendingPtyByPid yet — PTY may not have emitted pid-ready; retry after 500ms
      const retryPid = raw.pid;
      const retrySessionId = raw.sessionId;
      const retryCwd = raw.cwd;
      setTimeout(() => {
        if (ctx.pendingPtyByPid.has(retryPid)) {
          const entry = ctx.pendingPtyByPid.get(retryPid)!;
          ctx.pendingPtyByPid.delete(retryPid);
          ctx.ptyToClaudeId.set(entry.ptySessionId, retrySessionId);
          ctx.claudeToPtyId.set(retrySessionId, entry.ptySessionId);
          if (entry.ws) {
            const wsSessions = ctx.wsSessionMap.get(entry.ws);
            if (wsSessions) wsSessions.add(retrySessionId);
            ctx.sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: retrySessionId });
          } else {
            for (const sessions of ctx.wsSessionMap.values()) {
              sessions.add(retrySessionId);
            }
            ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: retrySessionId });
          }
          ctx.stateManager.setSessionType(retrySessionId, 'embedded');
          const retryPtyPid = ctx.ptyManager.getPid(entry.ptySessionId);
          if (retryPtyPid) ctx.stateManager.setPid(retrySessionId, retryPtyPid);
          applyPendingCloneInfo(entry.ptySessionId, retrySessionId);
          log('pty:started', 'PTY linked after retry', { sessionId: retrySessionId, sessionName: retrySessionId.slice(0, 8) });
        }
      }, 500);
    }
    // Fallback linking: match by sessionId directly in pendingPtyByResumeId (ConPTY resume flow)
    if (!linkedToPty && ctx.pendingPtyByResumeId.has(raw.sessionId)) {
      const entry = ctx.pendingPtyByResumeId.get(raw.sessionId)!;
      ctx.pendingPtyByResumeId.delete(raw.sessionId);
      linkedToPty = true;
      ctx.ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
      ctx.claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
      // Clear startup noise from the PTY buffer before linking
      ctx.ptyOutputBuffer.delete(entry.ptySessionId);
      if (entry.ws) {
        const wsSessions = ctx.wsSessionMap.get(entry.ws);
        if (wsSessions) wsSessions.add(raw.sessionId);
        ctx.sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      } else {
        for (const sessions of ctx.wsSessionMap.values()) {
          sessions.add(raw.sessionId);
        }
        ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      }
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
      if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
      log('pty:started', 'PTY linked via resumeId', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8) });
    }
    // Detect session replacement: same PID, different UUID (e.g. Claude Code's /clear)
    // Skip if this session was just linked to a PTY — it's a resume, not a /clear.
    // Skip during startup — known sessions from the initial scan are not /clear replacements.
    let replacedByPid = false;
    if (ctx.isStartupComplete() && !linkedToPty && raw.pid && raw.pid > 0 && !ctx.pendingPtyByPid.has(raw.pid) && !hasActiveResumeInProgress(ctx)) {
      const oldSession = ctx.stateManager.findSessionByPid(raw.pid, raw.sessionId);
      if (oldSession) {
        closeOrRemoveReplaced(ctx, oldSession.sessionId);
        ctx.stateManager.transferName(oldSession.sessionId, raw.sessionId);
        migratePtyMaps(ctx, oldSession.sessionId, raw.sessionId, raw.pid);
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId });
        const clearName1 = raw.proposedName ?? raw.sessionId.slice(0, 8);
        log('clear:detected', 'Clear detected', { sessionId: raw.sessionId, sessionName: clearName1, extra: oldSession.sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
        replacedByPid = true;
      }
    }
    // Fallback: CWD-based replacement detection for /clear (creates new PID)
    if (ctx.isStartupComplete() && !linkedToPty && !replacedByPid && !ctx.pendingPtyByPid.has(raw.pid) && !ctx.stateManager.hasPendingResume(raw.cwd) && !hasActiveResumeInProgress(ctx)) {
      const recent = ctx.recentlyRemovedByCwd.get(raw.cwd);
      const isCaveatSession = lastMessage?.startsWith('<local-command-caveat') ?? false;
      if (recent && recent.sessionId !== raw.sessionId && (Date.now() - recent.removedAt < 30000 || isCaveatSession)) {
        ctx.recentlyRemovedByCwd.delete(raw.cwd);
        closeOrRemoveReplaced(ctx, recent.sessionId);
        ctx.stateManager.transferName(recent.sessionId, raw.sessionId);
        migratePtyMaps(ctx, recent.sessionId, raw.sessionId, raw.pid);
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: recent.sessionId, newSessionId: raw.sessionId });
        const clearName2 = raw.proposedName ?? raw.sessionId.slice(0, 8);
        log('clear:detected', 'Clear detected', { sessionId: raw.sessionId, sessionName: clearName2, extra: recent.sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
      }
    }
    // Link pending bridge sessions (opened via "Open in Terminal" with bridge binary)
    if (!linkedToPty && ctx.linkPendingBridge) {
      ctx.linkPendingBridge(raw.sessionId, raw.cwd, raw.name);
    }
  });

  sessionWatcher.on('changed', (raw) => {
    // Detect in-place session replacement (e.g. Claude Code's /clear for non-PTY sessions)
    // The session file updates in-place with a new sessionId — same PID, different UUID
    if (raw.pid && raw.pid > 0) {
      const oldSession = ctx.stateManager.findSessionByPid(raw.pid, raw.sessionId);
      if (oldSession && oldSession.sessionId !== raw.sessionId) {
        // If the old session was an interim resume phantom (resumedFrom === new sessionId), remove entirely
        if (oldSession.resumedFrom === raw.sessionId) {
          ctx.stateManager.remove(oldSession.sessionId);
        } else {
          closeOrRemoveReplaced(ctx, oldSession.sessionId);
        }
        ctx.stateManager.addOrUpdate(raw);
        ctx.stateManager.transferName(oldSession.sessionId, raw.sessionId);
        migratePtyMaps(ctx, oldSession.sessionId, raw.sessionId);
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId });
        return; // already called addOrUpdate above
      }
    }
    ctx.stateManager.addOrUpdate(raw);
    // Link PTY by embedded marker in session name (changed handler)
    if (raw.name && raw.name.includes('___OVR:') && !ctx.claudeToPtyId.has(raw.sessionId)) {
      const marker = raw.name.split('___OVR:')[1];
      const ptyAlive = ctx.ptyManager.has(marker);
      console.log(`[marker-check] changed: sid=${raw.sessionId.slice(0,8)} marker=${marker} ptyAlive=${ptyAlive} alreadyLinked=${ctx.claudeToPtyId.has(raw.sessionId)}`);
      if (marker && ptyAlive) {
        ctx.ptyToClaudeId.set(marker, raw.sessionId);
        ctx.claudeToPtyId.set(raw.sessionId, marker);
        let ownerWs: WebSocket | null = null;
        for (const [ws, sessions] of ctx.wsSessionMap) {
          if (sessions.has(marker)) {
            ownerWs = ws;
            break;
          }
        }
        if (ownerWs) {
          const wsSessions = ctx.wsSessionMap.get(ownerWs);
          if (wsSessions) wsSessions.add(raw.sessionId);
          ctx.sendToClient(ownerWs, { type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
        } else {
          for (const sessions of ctx.wsSessionMap.values()) {
            sessions.add(raw.sessionId);
          }
          ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
        }
        ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
        const ptyPid = ctx.ptyManager.getPid(marker);
        if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
        applyPendingCloneInfo(marker, raw.sessionId);
        log('pty:started', 'PTY clone linked via name marker (changed)', { sessionId: raw.sessionId });
      }
    }
    // Check for pending PTY resume link (ConPTY: session file settles to target ID)
    if (ctx.pendingPtyByResumeId.has(raw.sessionId)) {
      const entry = ctx.pendingPtyByResumeId.get(raw.sessionId)!;
      ctx.pendingPtyByResumeId.delete(raw.sessionId);
      ctx.ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
      ctx.claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
      // Clear startup noise from the PTY buffer before linking
      ctx.ptyOutputBuffer.delete(entry.ptySessionId);
      if (entry.ws) {
        const wsSessions = ctx.wsSessionMap.get(entry.ws);
        if (wsSessions) wsSessions.add(raw.sessionId);
        ctx.sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      } else {
        for (const sessions of ctx.wsSessionMap.values()) {
          sessions.add(raw.sessionId);
        }
        ctx.broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
      }
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
      if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
      log('pty:started', 'PTY linked via resumeId (changed)', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8) });
    }
    // Link pending bridge sessions (name may arrive in 'changed' after initial 'added' without name)
    if (ctx.linkPendingBridge && raw.name?.includes('___BRG:')) {
      ctx.linkPendingBridge(raw.sessionId, raw.cwd, raw.name);
    }
  });

  sessionWatcher.on('removed', (sessionId: string) => {
    const session = ctx.stateManager.getSession(sessionId);
    const removedName = ctx.stateManager.getSession(sessionId)?.proposedName ?? sessionId.slice(0, 8);
    log('session:removed', 'Session removed', { sessionId, sessionName: removedName, extra: 'PID ' + (session?.pid ?? '?') });
    // Clean up PTY maps for removed sessions
    const ptyId = ctx.claudeToPtyId.get(sessionId);
    if (ptyId) {
      ctx.claudeToPtyId.delete(sessionId);
      ctx.ptyToClaudeId.delete(ptyId);
      console.log(`[removed] cleaned up PTY maps for ${sessionId} → pty=${ptyId}`);
    }
    if (session?.isWorker) {
      ctx.stateManager.remove(sessionId);
    } else {
      ctx.stateManager.markClosed(sessionId);
      // Track for CWD-based replacement detection (/clear creates new PID)
      if (session) {
        const now = Date.now();
        // Prune stale entries (older than 30s) to keep the map bounded
        for (const [cwd, entry] of ctx.recentlyRemovedByCwd) {
          if (now - entry.removedAt > 30000) ctx.recentlyRemovedByCwd.delete(cwd);
        }
        ctx.recentlyRemovedByCwd.set(session.cwd, { sessionId, removedAt: now });
      }
    }
  });
}
