import type { WebSocket } from 'ws';
import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { AiClassifier } from '../ai/aiClassifier.js';
import type { SessionSource } from './sessionWatcher.js';
import { findTranscriptPathAnywhere } from './transcriptReader.js';
import { sessionStore } from './sessionStore.js';
import { log } from '../logger.js';
import { applyPendingPermMode } from '../pty/ptyEvents.js';

export interface SessionEventContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  aiClassifier: AiClassifier;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ovrToPty: Map<string, string>;   // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;   // ptySessionId → ovrId
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws?: WebSocket; timestamp: number }>;
  pendingCloneInfo: Map<string, { name: string; originalSessionId: string }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  migrateBridgeSession?: (oldId: string, newId: string) => void;
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
// Always mark as deleted so it doesn't survive server restart as a ghost.
// The transcript file stays on disk (markDeleted only removes the session from the registry).
export function closeOrRemoveReplaced(ctx: SessionEventContext, oldSessionId: string): void {
  ctx.stateManager.markDeleted(oldSessionId);
  log('session:removed', 'Removed replaced session', { sessionId: oldSessionId, sessionName: oldSessionId.slice(0, 8) });
}

/**
 * Link a PTY session to a Claude session via ovrId.
 * Sets ovrToPty and ptyToOvr maps. No PTY migration is needed on /clear —
 * because the ovrId is stable and already points to the right PTY.
 *
 * If another ovrId previously owned this PTY, drop its stale ovrToPty entry so
 * the two maps stay consistent (one-PTY-per-ovrId invariant on the reverse map).
 */
function linkPtyToOvr(ctx: SessionEventContext, ovrId: string, ptySessionId: string): void {
  const previousOvr = ctx.ptyToOvr.get(ptySessionId);
  if (previousOvr && previousOvr !== ovrId && ctx.ovrToPty.get(previousOvr) === ptySessionId) {
    ctx.ovrToPty.delete(previousOvr);
  }
  ctx.ovrToPty.set(ovrId, ptySessionId);
  ctx.ptyToOvr.set(ptySessionId, ovrId);
  // Flush any mode detection that fired before linking (startup race: PTY output
  // arrives before ptyToOvr is set, so earlier calls used the ptySessionId fallback
  // and found no session). Now that ovrId is known, apply the buffered mode.
  applyPendingPermMode(ptySessionId, ovrId, ctx.stateManager);
}

export function registerSessionEventHandlers(sessionWatcher: SessionSource, ctx: SessionEventContext): void {

  function applyPendingCloneInfo(ptySessionId: string, claudeSessionId: string): void {
    const info = ctx.pendingCloneInfo.get(ptySessionId);
    if (info) {
      ctx.pendingCloneInfo.delete(ptySessionId);
      const session = ctx.stateManager.getSession(claudeSessionId);
      if (session) {
        session.proposedName = info.name;
        session.resumedFrom = info.originalSessionId;
        sessionStore.patchBySessionId(claudeSessionId, { proposedName: info.name, resumedFrom: info.originalSessionId });
        ctx.stateManager.refreshTranscript(claudeSessionId);
      }
      log('info', `Applied clone info: name="${info.name}", resumedFrom=${info.originalSessionId.slice(0, 8)} → ${claudeSessionId.slice(0, 8)}`);
    }
  }

  /** Broadcast terminal:linked and update wsSessionMap for a newly linked PTY. */
  function broadcastPtyLinked(
    ptySessionId: string,
    claudeSessionId: string,
    ovrId: string,
    ws?: WebSocket | null,
  ): void {
    const msg = { type: 'terminal:linked', ovrId, ptySessionId, claudeSessionId };
    if (ws) {
      const wsSessions = ctx.wsSessionMap.get(ws);
      if (wsSessions) { wsSessions.add(ptySessionId); wsSessions.add(ovrId); }
      ctx.sendToClient(ws, msg);
    } else {
      for (const sessions of ctx.wsSessionMap.values()) {
        sessions.add(ptySessionId);
        sessions.add(ovrId);
      }
      ctx.broadcastRaw(msg);
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

    const session = ctx.stateManager.getSession(raw.sessionId);
    const ovrId = session?.overlordId ?? raw.sessionId;

    // ── Link PTY by embedded marker in session name ──
    let linkedToPty = false;
    if (raw.name && raw.name.includes('___OVR:')) {
      const marker = raw.name.split('___OVR:')[1];
      const ptyAlive = ctx.ptyManager.has(marker);
      console.log(`[marker-check] added: marker=${marker} ptyAlive=${ptyAlive} ovrId=${ovrId}`);
      if (marker && ptyAlive) {
        linkedToPty = true;
        // If this PTY was already linked to a different session → compaction or /clear inside a Terminal tab.
        const existingOvrId = ctx.ptyToOvr.get(marker);
        if (existingOvrId && existingOvrId !== ovrId) {
          // PTY already has an ovrId: this is compaction — new session inherits the ovrId.
          const existingSession = ctx.stateManager.getActiveClaudeByOvr(existingOvrId);
          if (existingSession && existingSession.sessionId !== raw.sessionId) {
            ctx.stateManager.suppressBroadcast();
            ctx.stateManager.transferSessionState(existingSession.sessionId, raw.sessionId);
            const newOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? ovrId;
            ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: existingSession.sessionId, newSessionId: raw.sessionId, ovrId: newOvrId });
            closeOrRemoveReplaced(ctx, existingSession.sessionId);
            ctx.stateManager.resumeBroadcast();
            log('clear:detected', 'Compaction detected in embedded PTY (marker, added)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${newOvrId} ${existingSession.sessionId.slice(0, 8)}→${raw.sessionId.slice(0, 8)}` });
            // Use the inherited ovrId for subsequent linking
            const inheritedOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? existingOvrId;
            linkPtyToOvr(ctx, inheritedOvrId, marker);
            ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
            const ptyPid = ctx.ptyManager.getPid(marker);
            if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
            applyPendingCloneInfo(marker, raw.sessionId);
            log('pty:linked', 'PTY linked via marker (compaction)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${inheritedOvrId} ptyId=${marker}` });
          }
        } else {
          // Normal new link or same session — set ovrId mapping
          linkPtyToOvr(ctx, ovrId, marker);
          // Find the WS that owns this PTY
          let ownerWs: WebSocket | null = null;
          for (const [ws, sessions] of ctx.wsSessionMap) {
            if (sessions.has(marker)) { ownerWs = ws; break; }
          }
          broadcastPtyLinked(marker, raw.sessionId, ovrId, ownerWs);
          ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
          const ptyPid = ctx.ptyManager.getPid(marker);
          if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
          applyPendingCloneInfo(marker, raw.sessionId);
          log('pty:linked', 'PTY linked via name marker', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${ovrId} ptyId=${marker}` });
        }
      }
    }

    // ── Link PTY session to real Claude session by PID ──
    if (!linkedToPty && raw.pid && ctx.pendingPtyByPid.has(raw.pid)) {
      const entry = ctx.pendingPtyByPid.get(raw.pid)!;

      // Check if this PTY already has an ovrId (compaction-during-resume case).
      // If so, the new session is a replacement — inherit the existing ovrId.
      const existingOvrId = ctx.ptyToOvr.get(entry.ptySessionId);
      if (existingOvrId) {
        const existingSession = ctx.stateManager.getActiveClaudeByOvr(existingOvrId);
        if (existingSession && existingSession.sessionId !== raw.sessionId) {
          // Compaction: Z replaces 1a9b865b. PTY stays linked to same ovrId.
          ctx.pendingPtyByPid.delete(raw.pid);
          linkedToPty = true;
          ctx.stateManager.suppressBroadcast();
          ctx.stateManager.transferSessionState(existingSession.sessionId, raw.sessionId);
          const inheritedOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? existingOvrId;
          ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: existingSession.sessionId, newSessionId: raw.sessionId, ovrId: inheritedOvrId });
          closeOrRemoveReplaced(ctx, existingSession.sessionId);
          ctx.stateManager.resumeBroadcast();
          ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
          const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
          if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
          applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
          log('clear:detected', 'Compaction detected in PTY (PID path, added)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${inheritedOvrId} ${existingSession.sessionId.slice(0, 8)}→${raw.sessionId.slice(0, 8)}` });
        } else {
          // Same session re-appearing (shouldn't normally happen) — just consume the entry
          ctx.pendingPtyByPid.delete(raw.pid);
          linkedToPty = true;
        }
      } else {
        // Normal new spawn — link PTY to this session's ovrId
        ctx.pendingPtyByPid.delete(raw.pid);
        linkedToPty = true;
        linkPtyToOvr(ctx, ovrId, entry.ptySessionId);
        ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
        broadcastPtyLinked(entry.ptySessionId, raw.sessionId, ovrId, entry.ws ?? null);
        const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
        if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
        applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
        const ptySessionName = ctx.stateManager.getSession(raw.sessionId)?.proposedName ?? raw.proposedName ?? raw.sessionId.slice(0, 8);
        log('pty:linked', 'PTY linked via PID', { sessionId: raw.sessionId, sessionName: ptySessionName, extra: `ovrId=${ovrId} ptyId=${entry.ptySessionId}` });
      }
    } else if (raw.pid && !ctx.pendingPtyByPid.has(raw.pid) && ctx.stateManager.hasPendingResume(raw.cwd)) {
      // PID not in pendingPtyByPid yet — PTY may not have emitted pid-ready; retry after 500ms
      const retryPid = raw.pid;
      const retrySessionId = raw.sessionId;
      const retryOvrId = ovrId;
      setTimeout(() => {
        if (ctx.pendingPtyByPid.has(retryPid)) {
          const entry = ctx.pendingPtyByPid.get(retryPid)!;
          ctx.pendingPtyByPid.delete(retryPid);
          const existingOvrId = ctx.ptyToOvr.get(entry.ptySessionId);
          if (existingOvrId) {
            // Compaction case in retry path — same logic as above
            const existingSession = ctx.stateManager.getActiveClaudeByOvr(existingOvrId);
            if (existingSession && existingSession.sessionId !== retrySessionId) {
              ctx.stateManager.suppressBroadcast();
              ctx.stateManager.transferSessionState(existingSession.sessionId, retrySessionId);
              const inheritedOvrId = ctx.stateManager.getSession(retrySessionId)?.overlordId ?? existingOvrId;
              ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: existingSession.sessionId, newSessionId: retrySessionId, ovrId: inheritedOvrId });
              closeOrRemoveReplaced(ctx, existingSession.sessionId);
              ctx.stateManager.resumeBroadcast();
              ctx.stateManager.setSessionType(retrySessionId, 'embedded');
              const retryPtyPid = ctx.ptyManager.getPid(entry.ptySessionId);
              if (retryPtyPid) ctx.stateManager.setPid(retrySessionId, retryPtyPid);
              log('clear:detected', 'Compaction detected in PTY (PID retry path)', { sessionId: retrySessionId, sessionName: retrySessionId.slice(0, 8), extra: `ovrId=${inheritedOvrId}` });
              return;
            }
          }
          linkPtyToOvr(ctx, retryOvrId, entry.ptySessionId);
          const wsSessions = entry.ws ? ctx.wsSessionMap.get(entry.ws) : undefined;
          if (wsSessions) wsSessions.add(retryOvrId);
          broadcastPtyLinked(entry.ptySessionId, retrySessionId, retryOvrId, entry.ws ?? null);
          ctx.stateManager.setSessionType(retrySessionId, 'embedded');
          const retryPtyPid = ctx.ptyManager.getPid(entry.ptySessionId);
          if (retryPtyPid) ctx.stateManager.setPid(retrySessionId, retryPtyPid);
          applyPendingCloneInfo(entry.ptySessionId, retrySessionId);
          log('pty:linked', 'PTY linked after retry', { sessionId: retrySessionId, sessionName: retrySessionId.slice(0, 8), extra: `ovrId=${retryOvrId} ptyId=${entry.ptySessionId}` });
        }
      }, 500);
    }

    // ── Fallback linking: match by sessionId directly in pendingPtyByResumeId (ConPTY resume flow) ──
    if (!linkedToPty && ctx.pendingPtyByResumeId.has(raw.sessionId)) {
      const entry = ctx.pendingPtyByResumeId.get(raw.sessionId)!;
      ctx.pendingPtyByResumeId.delete(raw.sessionId);
      linkedToPty = true;
      linkPtyToOvr(ctx, ovrId, entry.ptySessionId);
      // Clear startup noise from the PTY buffer before linking
      ctx.ptyOutputBuffer.delete(entry.ptySessionId);
      broadcastPtyLinked(entry.ptySessionId, raw.sessionId, ovrId, entry.ws ?? null);
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
      if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
      log('pty:linked', 'PTY linked via resumeId', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8), extra: `ovrId=${ovrId} ptyId=${entry.ptySessionId}` });
    }

    // ── Detect session replacement: same PID, different UUID (e.g. Claude Code's /clear) ──
    // Skip if linked to PTY — it's a resume, not a /clear.
    // Skip during startup — known sessions from the initial scan are not /clear replacements.
    if (ctx.isStartupComplete() && !linkedToPty && raw.pid && raw.pid > 0 && !ctx.pendingPtyByPid.has(raw.pid) && !hasActiveResumeInProgress(ctx)) {
      // Pass raw.startedAt so we only match an in-place /clear (same pid AND
      // same startedAt) — not a concurrent --resume with the same pid.
      const oldSession = ctx.stateManager.findSessionByPid(raw.pid, raw.sessionId, raw.startedAt);
      if (oldSession) {
        ctx.stateManager.suppressBroadcast();
        ctx.stateManager.transferSessionState(oldSession.sessionId, raw.sessionId);
        const newOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? ovrId;
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId, ovrId: newOvrId });
        closeOrRemoveReplaced(ctx, oldSession.sessionId);
        ctx.stateManager.resumeBroadcast();
        // Migrate bridge session if needed
        if (ctx.stateManager.isBridge(oldSession.sessionId)) {
          ctx.migrateBridgeSession?.(oldSession.sessionId, raw.sessionId);
        }
        const clearName1 = raw.proposedName ?? raw.sessionId.slice(0, 8);
        log('clear:detected', 'Clear detected', { sessionId: raw.sessionId, sessionName: clearName1, extra: `ovrId=${newOvrId} ${oldSession.sessionId.slice(0, 8)}→${raw.sessionId.slice(0, 8)}` });
      }
    }

    // ── Link pending bridge sessions ──
    if (!linkedToPty && ctx.linkPendingBridge) {
      ctx.linkPendingBridge(raw.sessionId, raw.cwd, raw.name);
    }
  });

  sessionWatcher.on('changed', (raw) => {
    // Detect in-place session replacement (e.g. Claude Code's /clear for non-PTY sessions)
    // The session file updates in-place with a new sessionId — same PID, different UUID
    if (raw.pid && raw.pid > 0) {
      // Gate on startedAt: a real /clear preserves startedAt, a concurrent
      // --resume or pid reuse does not.
      const oldSession = ctx.stateManager.findSessionByPid(raw.pid, raw.sessionId, raw.startedAt);
      if (oldSession && oldSession.sessionId !== raw.sessionId) {
        // Revert detection: if raw.sessionId is an EARLIER entry in the
        // ovrId's sessionHistory, this is a sid-revert (auto-compaction
        // rebinding to the original transcript), not a forward /clear.
        // Skip transferSessionState; promote the prior sid back to active.
        const ovrId = oldSession.overlordId;
        if (ovrId && ctx.stateManager.isRevertCandidate(ovrId, raw.sessionId)) {
          ctx.stateManager.suppressBroadcast();
          ctx.stateManager.revertToSid(oldSession.sessionId, raw.sessionId);
          ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId, ovrId });
          if (ctx.stateManager.isBridge(raw.sessionId)) {
            ctx.migrateBridgeSession?.(oldSession.sessionId, raw.sessionId);
          }
          ctx.stateManager.resumeBroadcast();
          return;
        }

        ctx.stateManager.suppressBroadcast();
        ctx.stateManager.addOrUpdate({ ...raw, startedAt: oldSession.startedAt });
        ctx.stateManager.transferSessionState(oldSession.sessionId, raw.sessionId);
        const newOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? raw.sessionId;
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId, ovrId: newOvrId });
        closeOrRemoveReplaced(ctx, oldSession.sessionId);
        // Migrate bridge session if needed
        if (ctx.stateManager.isBridge(oldSession.sessionId)) {
          ctx.migrateBridgeSession?.(oldSession.sessionId, raw.sessionId);
        }
        ctx.stateManager.resumeBroadcast();
        log('clear:detected', 'Clear detected (changed)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${newOvrId} ${oldSession.sessionId.slice(0, 8)}→${raw.sessionId.slice(0, 8)}` });
        return;
      }
    }
    ctx.stateManager.addOrUpdate(raw);

    const session = ctx.stateManager.getSession(raw.sessionId);
    const ovrId = session?.overlordId ?? raw.sessionId;

    // ── Link PTY by embedded marker in session name (changed handler) ──
    if (raw.name && raw.name.includes('___OVR:') && !ctx.ovrToPty.has(ovrId)) {
      const marker = raw.name.split('___OVR:')[1];
      const ptyAlive = ctx.ptyManager.has(marker);
      console.log(`[marker-check] changed: sid=${raw.sessionId.slice(0, 8)} marker=${marker} ptyAlive=${ptyAlive} alreadyLinked=${ctx.ovrToPty.has(ovrId)}`);
      if (marker && ptyAlive) {
        const existingOvrId = ctx.ptyToOvr.get(marker);
        if (existingOvrId && existingOvrId !== ovrId) {
          // PTY already linked to a different session — compaction or /clear
          const existingSession = ctx.stateManager.getActiveClaudeByOvr(existingOvrId);
          if (existingSession && existingSession.sessionId !== raw.sessionId) {
            ctx.stateManager.suppressBroadcast();
            ctx.stateManager.transferSessionState(existingSession.sessionId, raw.sessionId);
            const inheritedOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? existingOvrId;
            ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: existingSession.sessionId, newSessionId: raw.sessionId, ovrId: inheritedOvrId });
            closeOrRemoveReplaced(ctx, existingSession.sessionId);
            ctx.stateManager.resumeBroadcast();
            linkPtyToOvr(ctx, inheritedOvrId, marker);
            ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
            const ptyPid = ctx.ptyManager.getPid(marker);
            if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
            log('clear:detected', 'Compaction detected in embedded PTY (marker, changed)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${inheritedOvrId} ${existingSession.sessionId.slice(0, 8)}→${raw.sessionId.slice(0, 8)}` });
          }
        } else {
          linkPtyToOvr(ctx, ovrId, marker);
          let ownerWs: WebSocket | null = null;
          for (const [ws, sessions] of ctx.wsSessionMap) {
            if (sessions.has(marker)) { ownerWs = ws; break; }
          }
          broadcastPtyLinked(marker, raw.sessionId, ovrId, ownerWs);
          ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
          const ptyPid = ctx.ptyManager.getPid(marker);
          if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
          applyPendingCloneInfo(marker, raw.sessionId);
          log('pty:linked', 'PTY linked via name marker (changed)', { sessionId: raw.sessionId, sessionName: raw.proposedName ?? raw.sessionId.slice(0, 8), extra: `ovrId=${ovrId} ptyId=${marker}` });
        }
      }
    }

    // ── Check for pending PTY resume link (ConPTY: session file settles to target ID) ──
    if (ctx.pendingPtyByResumeId.has(raw.sessionId)) {
      const entry = ctx.pendingPtyByResumeId.get(raw.sessionId)!;
      ctx.pendingPtyByResumeId.delete(raw.sessionId);
      linkPtyToOvr(ctx, ovrId, entry.ptySessionId);
      ctx.ptyOutputBuffer.delete(entry.ptySessionId);
      broadcastPtyLinked(entry.ptySessionId, raw.sessionId, ovrId, entry.ws ?? null);
      ctx.stateManager.setSessionType(raw.sessionId, 'embedded');
      const ptyPid = ctx.ptyManager.getPid(entry.ptySessionId);
      if (ptyPid) ctx.stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
      log('pty:linked', 'PTY linked via resumeId (changed)', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8), extra: `ovrId=${ovrId} ptyId=${entry.ptySessionId}` });
    }

    // ── Link pending bridge sessions (name may arrive in 'changed') ──
    if (ctx.linkPendingBridge && raw.name?.includes('___BRG:')) {
      ctx.linkPendingBridge(raw.sessionId, raw.cwd, raw.name);
    }
  });

  sessionWatcher.on('removed', (sessionId: string) => {
    const session = ctx.stateManager.getSession(sessionId);
    const removedName = session?.proposedName ?? sessionId.slice(0, 8);
    log('session:removed', 'Session removed', { sessionId, sessionName: removedName, extra: 'PID ' + (session?.pid ?? '?') });
    // Clean up PTY maps for removed sessions
    const ovrId = session?.overlordId;
    if (ovrId) {
      const ptyId = ctx.ovrToPty.get(ovrId);
      if (ptyId) {
        // Only remove if this session is still the active one for this ovrId
        if (ctx.stateManager.getActiveClaudeByOvr(ovrId)?.sessionId === sessionId) {
          ctx.ovrToPty.delete(ovrId);
          ctx.ptyToOvr.delete(ptyId);
          console.log(`[removed] cleaned up PTY maps for ${sessionId.slice(0, 8)} ovrId=${ovrId} pty=${ptyId}`);
        }
      }
    }
    if (session?.isWorker) {
      ctx.stateManager.remove(sessionId);
    } else {
      ctx.stateManager.markClosed(sessionId);
    }
  });
}
