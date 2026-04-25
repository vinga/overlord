import * as os from 'os';
import * as fs from 'fs';
import { join } from 'path';
import chokidar from 'chokidar';
import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { AiClassifier } from '../ai/aiClassifier.js';
import type { IntentSummarizer } from '../ai/intentSummary.js';
import type { SessionEventContext } from './sessionEventHandlers.js';
import { markTranscriptDirty } from './transcriptReader.js';
import { closeOrRemoveReplaced } from './sessionEventHandlers.js';
import { log } from '../logger.js';

export interface TranscriptWatcherContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  aiClassifier: AiClassifier;
  intentSummarizer: IntentSummarizer;
  sessionCtx: SessionEventContext;
  broadcastRaw: (msg: object) => void;
  linkageTracker: import('./ptyLinkageTracker.js').PtyLinkageTracker;
}

export function startTranscriptWatcher(ctx: TranscriptWatcherContext): void {
  const transcriptDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Watch project transcripts for real-time updates
  const projectsDir = join(os.homedir(), '.claude', 'projects');

  function parseTranscriptPath(filePath: string): { sessionId: string; isSubagent: boolean } | null {
    if (!filePath.endsWith('.jsonl')) return null;
    const parts = filePath.replace(/\\/g, '/').split('/');
    const subagentsIdx = parts.indexOf('subagents');
    const isSubagent = subagentsIdx !== -1;
    // For subagents, sessionId is the parent session (one level above 'subagents')
    // For main files, sessionId is derived from the basename
    const sessionId = isSubagent
      ? (parts[subagentsIdx - 1] ?? '')
      : (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '');
    if (!sessionId) return null;
    return { sessionId, isSubagent };
  }

  function handleTranscriptFile(filePath: string): void {
    const parsed = parseTranscriptPath(filePath);
    if (!parsed) return;
    // Mark dirty immediately so the next poll knows to re-read the file
    markTranscriptDirty(filePath);
    const { sessionId, isSubagent } = parsed;
    // Unknown non-subagent session changing — could be an orphan after server restart
    // (ignoreInitial:true means existing files don't fire 'add'). Run replacement detection.
    if (!isSubagent && !ctx.stateManager.getSession(sessionId)) {
      handleTranscriptAdded(filePath);
      return;
    }
    const existing = transcriptDebounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    transcriptDebounceTimers.set(sessionId, setTimeout(() => {
      transcriptDebounceTimers.delete(sessionId);
      ctx.stateManager.refreshTranscript(sessionId);
    }, 150));
  }

  // Handle new .jsonl files appearing — register unknown sessions.
  // /clear detection is NOT done here. Instead, /clear is detected by:
  //   1. sessionEventHandlers 'changed' — session file updates in-place with new sessionId (same PID)
  //   2. Periodic stale transcript check (3s interval) — reads session file, detects sessionId mismatch
  //   3. detectClearOnStartup() — PID file comparison for server-was-down cases
  function handleTranscriptAdded(filePath: string): void {
    const parsed = parseTranscriptPath(filePath);
    if (!parsed) return;

    if (parsed.isSubagent) {
      handleTranscriptFile(filePath);
      return;
    }

    const newSessionId = parsed.sessionId;
    if (!newSessionId) return;

    // If already known, nothing to do — normal refresh will handle it
    if (ctx.stateManager.getSession(newSessionId)) {
      handleTranscriptFile(filePath);
      return;
    }

    // Unknown session: read cwd and register as standalone.
    // The session watcher or /clear detection mechanisms will link it properly if needed.
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      let cwd: string | undefined;
      let customTitle: string | undefined;
      for (const line of lines.slice(0, 15)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
          if (!customTitle && typeof entry.customTitle === 'string') customTitle = entry.customTitle;
          if (cwd && customTitle) break;
        } catch { /* skip malformed */ }
      }

      // Marker-based fallback /clear detection: when Claude Code creates a new transcript
      // for /clear but does NOT update {pid}.json (observed for bridge sessions), the PID
      // paths miss it. The new transcript preserves the original ___BRG:<marker> or
      // ___OVR:<ptyId> in customTitle, so we can find the live session and replace in place.
      const matchedOldSession: { sessionId: string; cwd: string; pid: number; startedAt: number; proposedName?: string; isBridge: boolean } | null = (() => {
        if (!customTitle) return null;
        if (customTitle.includes('___BRG:')) {
          const marker = customTitle.split('___BRG:')[1];
          if (!marker) return null;
          const s = ctx.stateManager.findActiveBridgeByMarker(marker);
          if (!s || s.sessionId === newSessionId) return null;
          return { sessionId: s.sessionId, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt, proposedName: s.proposedName, isBridge: true };
        }
        if (customTitle.includes('___OVR:')) {
          const ptyId = customTitle.split('___OVR:')[1];
          if (!ptyId) return null;
          const ovrId = ctx.sessionCtx.ptyToOvr.get(ptyId);
          if (!ovrId) return null;
          const s = ctx.stateManager.getActiveClaudeByOvr(ovrId);
          if (!s || s.sessionId === newSessionId) return null;
          return { sessionId: s.sessionId, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt, proposedName: s.proposedName, isBridge: false };
        }
        return null;
      })();

      if (matchedOldSession) {
        const oldName = matchedOldSession.proposedName ?? matchedOldSession.sessionId.slice(0, 8);
        ctx.stateManager.suppressBroadcast();
        ctx.stateManager.undelete(newSessionId);
        const existingNew = ctx.stateManager.getSession(newSessionId);
        if (existingNew && existingNew.pid === 0) ctx.stateManager.remove(newSessionId);
        ctx.stateManager.addOrUpdate({
          sessionId: newSessionId,
          pid: matchedOldSession.pid,
          cwd: cwd ?? matchedOldSession.cwd,
          startedAt: matchedOldSession.startedAt,
        });
        ctx.stateManager.transferName(matchedOldSession.sessionId, newSessionId);
        const ovrId = ctx.stateManager.getSession(newSessionId)?.overlordId ?? newSessionId;
        if (matchedOldSession.isBridge) {
          ctx.sessionCtx.migrateBridgeSession?.(matchedOldSession.sessionId, newSessionId);
        }
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: matchedOldSession.sessionId, newSessionId, ovrId });
        ctx.stateManager.markDeleted(matchedOldSession.sessionId);
        ctx.stateManager.resumeBroadcast();
        log('clear:detected', 'Marker fallback /clear detected', { sessionId: newSessionId, sessionName: oldName, extra: `${matchedOldSession.isBridge ? 'BRG' : 'OVR'} ${matchedOldSession.sessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)}` });
        handleTranscriptFile(filePath);
        return;
      }

      if (cwd) {
        // Check if there's a pending clear for this exact session — triggered by the UI Clear button.
        // This is NOT CWD matching: the pending entry was explicitly recorded when /clear was injected
        // into a known session. We use CWD only to verify the orphan belongs to the same project.
        const pending = ctx.stateManager.consumePendingClearReplacement(cwd);
        if (pending) {
          const clearSession = ctx.stateManager.getSession(pending.sessionId);
          console.log(`[transcript:add] pending found: ${pending.sessionId.slice(0, 8)}, clearSession=${!!clearSession}`);
          if (clearSession) {
            const clearName = clearSession.proposedName ?? pending.sessionId.slice(0, 8);
            console.log(`[transcript:add] pending-clear replacement: ${pending.sessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)}`);
            // Suppress intermediate snapshots — client must receive session:replaced before any snapshot
            ctx.stateManager.suppressBroadcast();
            ctx.stateManager.undelete(newSessionId);
            const existingNew = ctx.stateManager.getSession(newSessionId);
            if (existingNew && existingNew.pid === 0) ctx.stateManager.remove(newSessionId);
            // Inherit old session's startedAt to preserve sort order after /clear
            ctx.stateManager.addOrUpdate({ sessionId: newSessionId, pid: clearSession.pid, cwd, startedAt: clearSession.startedAt });
            // transferName must run BEFORE removing old session so it can read proposedName/bridge/PTY state.
            // transferSessionState propagates overlordId so PTY routing (keyed by ovrId) stays valid.
            ctx.stateManager.transferName(pending.sessionId, newSessionId);
            const pendingOvrId = ctx.stateManager.getSession(newSessionId)?.overlordId ?? newSessionId;
            // Bridge migration (if applicable)
            if (ctx.stateManager.isBridge(pending.sessionId)) {
              ctx.sessionCtx.migrateBridgeSession?.(pending.sessionId, newSessionId);
            }
            // Broadcast session:replaced BEFORE markDeleted so client migrates room order
            // before the snapshot that removes the old session arrives.
            ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: pending.sessionId, newSessionId, ovrId: pendingOvrId });
            // markDeleted (not just remove) so session watcher won't re-register old session from stale {pid}.json
            ctx.stateManager.markDeleted(pending.sessionId);
            ctx.stateManager.resumeBroadcast();
            log('clear:detected', 'Live clear detected via UI Clear button', { sessionId: newSessionId, sessionName: clearName, extra: pending.sessionId.slice(0, 8) + ' → ' + newSessionId.slice(0, 8) });
            handleTranscriptFile(filePath);
            return;
          }
        }

        // Skip internal Overlord worker sessions (haiku-worker, etc.)
        const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/');
        if (cwdNorm.includes('/.claude/')) return;

        // Skip deleted sessions — addOrUpdate is a no-op for them, which would cause
        // handleTranscriptFile below to re-call handleTranscriptAdded infinitely.
        if (ctx.stateManager.isDeleted(newSessionId)) return;
        ctx.stateManager.addOrUpdate({ sessionId: newSessionId, pid: 0, cwd, startedAt: Date.now() });
        console.log(`[transcript:add] new session: ${newSessionId.slice(0, 8)} (cwd: ${cwd})`);

        // Session registered — trigger normal refresh so activityFeed is populated.
        // MUST return after this to avoid the unconditional handleTranscriptFile below,
        // which would see the session as unknown (if addOrUpdate was skipped) and recurse.
        handleTranscriptFile(filePath);
        return;
      }
      // cwd not found in first 15 lines: don't call handleTranscriptFile — session not
      // registered yet, calling it would trigger infinite handleTranscriptAdded recursion.
      console.log(`[transcript:add] no cwd in ${newSessionId.slice(0, 8)}, deferring (will retry on next change)`);
      return;
    } catch {
      // File not readable yet — skip. Chokidar will fire 'change' when it's ready.
      console.log(`[transcript:add] read error for ${newSessionId.slice(0, 8)}, deferring`);
      return;
    }
  }

  chokidar
    .watch(projectsDir, {
      depth: 4,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    })
    .on('add', handleTranscriptAdded)
    .on('change', handleTranscriptFile);

  // Periodic state refresh — re-evaluate all session states every 3s
  // (smallest state threshold is 3s, so polling must be at least that frequent)
  setInterval(() => {
    for (const sessionId of ctx.stateManager.getAllSessionIds()) {
      const session = ctx.stateManager.getSession(sessionId);
      if (session?.state === 'closed') continue;
      const { becameWaiting, lastMessage, becameWorking, leftWorking, transcriptStale } = ctx.stateManager.refreshTranscript(sessionId);
      // Stale transcript detection: re-read session file to check for /clear
      if (transcriptStale) {
        const sess2 = ctx.stateManager.getSession(sessionId);
        if (sess2 && sess2.pid > 0) {
          const sessionFilePath = join(os.homedir(), '.claude', 'sessions', `${sess2.pid}.json`);
          try {
            if (fs.existsSync(sessionFilePath)) {
              const raw = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8')) as { pid: number; sessionId: string; cwd: string; startedAt: number };
              // Also require startedAt to match — a genuine /clear rewrites the
              // session file in place and preserves startedAt, while OS pid reuse
              // produces a fresh startedAt and must not be treated as /clear.
              const startedAtMatches = raw.startedAt === sess2.startedAt;
              if (raw.sessionId !== sessionId && startedAtMatches && !ctx.stateManager.isDeleted(raw.sessionId)) {
                const clearName = sess2.proposedName ?? sessionId.slice(0, 8);
                ctx.stateManager.suppressBroadcast();
                ctx.stateManager.addOrUpdate(raw);
                ctx.stateManager.transferName(sessionId, raw.sessionId);
                const staleOvrId = ctx.stateManager.getSession(raw.sessionId)?.overlordId ?? raw.sessionId;
                // Bridge migration (if applicable)
                if (ctx.stateManager.isBridge(sessionId)) {
                  ctx.sessionCtx.migrateBridgeSession?.(sessionId, raw.sessionId);
                }
                ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: sessionId, newSessionId: raw.sessionId, ovrId: staleOvrId });
                closeOrRemoveReplaced(ctx.sessionCtx, sessionId);
                ctx.stateManager.resumeBroadcast();
                log('clear:detected', 'Stale transcript clear detected', { sessionId: raw.sessionId, sessionName: clearName, extra: sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
              }
            }
          } catch {
            // ignore read errors
          }
        }
      }
      const sess = ctx.stateManager.getSession(sessionId);
      if (becameWaiting && lastMessage && !sess?.isWorker) {
        void ctx.aiClassifier.classifyCompletion(sessionId, lastMessage);
      }
      if (becameWorking && !sess?.isWorker) {
        ctx.aiClassifier.cancelLabel(sessionId);
        ctx.aiClassifier.scheduleLabel(sessionId);
      }
      if (leftWorking && !sess?.isWorker) {
        ctx.aiClassifier.cancelLabel(sessionId);
      }
      // Fallback: sessions already working/thinking with no label and no pending timer
      const currentSession = ctx.stateManager.getSession(sessionId);
      if (currentSession && !currentSession.isWorker && (currentSession.state === 'working' || currentSession.state === 'thinking') && !ctx.aiClassifier.hasLabelScheduled(sessionId) && !ctx.aiClassifier.isGeneratingLabel(sessionId)) {
        ctx.aiClassifier.scheduleLabel(sessionId);
      }
      // Rolling intent summary — generated for every non-closed, non-worker session.
      // Debounced 2s per session; refreshed every ≥5 new user turns. Frozen on close.
      if (currentSession && !currentSession.isWorker) {
        ctx.intentSummarizer.maybeRefreshIntent(sessionId, currentSession.cwd);
      }
    }
  }, 3_000);

  // Periodic cleanup of leaked PTY entries (every 60s)
  setInterval(() => {
    for (const [pid, entry] of ctx.linkageTracker.byPid) {
      if (!ctx.ptyManager.has(entry.ptySessionId)) {
        ctx.linkageTracker.consumePid(pid);
      }
    }
    // Clean up stale byResumeId entries (older than 60s or PTY no longer alive)
    const now = Date.now();
    for (const [resumeId, entry] of ctx.linkageTracker.byResumeId) {
      if (now - entry.timestamp > 60_000 || !ctx.ptyManager.has(entry.ptySessionId)) {
        ctx.linkageTracker.consumeResume(resumeId);
      }
    }
  }, 60_000);
}
