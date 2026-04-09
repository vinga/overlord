import * as os from 'os';
import * as fs from 'fs';
import { join } from 'path';
import chokidar from 'chokidar';
import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { AiClassifier } from '../ai/aiClassifier.js';
import type { SessionEventContext } from './sessionEventHandlers.js';
import { markTranscriptDirty } from './transcriptReader.js';
import { hasActiveResumeInProgress, closeOrRemoveReplaced, migratePtyMaps } from './sessionEventHandlers.js';
import { log } from '../logger.js';

export interface TranscriptWatcherContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  aiClassifier: AiClassifier;
  sessionCtx: SessionEventContext;
  broadcastRaw: (msg: object) => void;
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: unknown }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws: unknown; timestamp: number }>;
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
  // /clear detection is NOT done here (CWD matching is unreliable — multiple sessions share CWDs).
  // Instead, /clear is detected by:
  //   1. sessionEventHandlers 'changed' — session file updates in-place with new sessionId (same PID)
  //   2. Periodic stale transcript check (3s interval) — reads session file, detects sessionId mismatch
  //   3. Startup orphan scan — content-based verification for server-was-down cases
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
      for (const line of lines.slice(0, 15)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.cwd && typeof entry.cwd === 'string') { cwd = entry.cwd; break; }
        } catch { /* skip malformed */ }
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
            ctx.stateManager.undelete(newSessionId);
            const existingNew = ctx.stateManager.getSession(newSessionId);
            if (existingNew && existingNew.pid === 0) ctx.stateManager.remove(newSessionId);
            ctx.stateManager.addOrUpdate({ sessionId: newSessionId, pid: clearSession.pid, cwd, startedAt: Date.now() });
            // transferName and migratePtyMaps must run BEFORE removing old session
            // so they can still read old session's proposedName and bridge/PTY state
            ctx.stateManager.transferName(pending.sessionId, newSessionId);
            migratePtyMaps(ctx.sessionCtx, pending.sessionId, newSessionId, clearSession.pid);
            // Broadcast session:replaced BEFORE markDeleted so client migrates room order
            // before the snapshot that removes the old session arrives.
            ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: pending.sessionId, newSessionId });
            // markDeleted (not just remove) so session watcher won't re-register old session from stale {pid}.json
            ctx.stateManager.markDeleted(pending.sessionId);
            log('clear:detected', 'Live clear detected via UI Clear button', { sessionId: newSessionId, sessionName: clearName, extra: pending.sessionId.slice(0, 8) + ' → ' + newSessionId.slice(0, 8) });
            handleTranscriptFile(filePath);
            return;
          }
        }

        // /clear detection fallback: new transcript has /clear in its first lines.
        // Only replace if there is exactly ONE candidate session in the same CWD of each type —
        // ambiguous cases (multiple bridge or PTY sessions in same dir) are left alone.
        const hasClear = lines.slice(0, 20).some(line => {
          if (!line.trim()) return false;
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            const content = (e.message as Record<string, unknown> | undefined)?.content;
            if (typeof content === 'string') return content.includes('<command-name>/clear</command-name>');
            if (Array.isArray(content)) return (content as Array<Record<string, unknown>>).some(
              p => typeof p.text === 'string' && p.text.includes('<command-name>/clear</command-name>'));
            return false;
          } catch { return false; }
        });

        if (hasClear) {
          const normalCwd = cwd.replace(/\\/g, '/').toLowerCase();

          // Bridge sessions: replace only when unambiguous (exactly 1 bridge in same CWD)
          const bridgeMatches = [...ctx.sessionCtx.bridgeSessions].filter(id => {
            if (id === newSessionId) return false;
            const s = ctx.stateManager.getSession(id);
            return s && s.state !== 'closed' && s.cwd.replace(/\\/g, '/').toLowerCase() === normalCwd;
          });
          // Embedded PTY sessions: replace only when unambiguous (exactly 1 PTY in same CWD)
          const ptyMatches = [...ctx.sessionCtx.claudeToPtyId.keys()].filter(id => {
            if (id === newSessionId) return false;
            const s = ctx.stateManager.getSession(id);
            return s && s.state !== 'closed' && s.cwd.replace(/\\/g, '/').toLowerCase() === normalCwd;
          });

          const clearId = bridgeMatches.length === 1 ? bridgeMatches[0]
            : ptyMatches.length === 1 ? ptyMatches[0]
            : undefined;

          if (clearId) {
            const clearSession = ctx.stateManager.getSession(clearId)!;
            const clearName = clearSession.proposedName ?? clearId.slice(0, 8);
            const kind = bridgeMatches.length === 1 ? 'bridge' : 'PTY';
            console.log(`[transcript:add] ${kind} /clear detected: ${clearId.slice(0, 8)} → ${newSessionId.slice(0, 8)}`);
            ctx.stateManager.undelete(newSessionId);
            const existingNew = ctx.stateManager.getSession(newSessionId);
            if (existingNew && existingNew.pid === 0) ctx.stateManager.remove(newSessionId);
            ctx.stateManager.addOrUpdate({ sessionId: newSessionId, pid: clearSession.pid, cwd, startedAt: Date.now() });
            ctx.stateManager.transferName(clearId, newSessionId);
            migratePtyMaps(ctx.sessionCtx, clearId, newSessionId, clearSession.pid);
            ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: clearId, newSessionId });
            ctx.stateManager.markDeleted(clearId);
            log('clear:detected', `${kind} /clear detected via terminal`, { sessionId: newSessionId, sessionName: clearName, extra: clearId.slice(0, 8) + ' → ' + newSessionId.slice(0, 8) });
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

  // Startup scan: for each stale session (transcript >1h old, PID alive), look for an
  // orphan transcript that references its sessionId — indicating a /clear replacement
  // that happened while the server was down.
  // Unlike handleTranscriptAdded (which uses CWD matching), this uses content-based
  // verification to avoid mismatching when multiple sessions share the same CWD.
  setTimeout(() => {
    try {
      const knownIds = new Set(ctx.stateManager.getAllSessionIds());
      // Collect stale sessions grouped by slug dir
      const staleBySlug = new Map<string, Array<{ sessionId: string; pid: number; cwd: string }>>();
      for (const sessionId of knownIds) {
        const session = ctx.stateManager.getSession(sessionId);
        if (!session || session.state === 'closed' || session.pid <= 0) continue;
        if (session.isWorker) continue;
        const lastActivityAge = Date.now() - new Date(session.lastActivity).getTime();
        if (lastActivityAge > 900_000) { // 15 min — catches recent post-clear orphans
          const slug = session.cwd.replace(/[\\:/]/g, '-').replace(/^-+/, '');
          if (!staleBySlug.has(slug)) staleBySlug.set(slug, []);
          staleBySlug.get(slug)!.push({ sessionId, pid: session.pid, cwd: session.cwd });
        }
      }
      if (staleBySlug.size === 0) return;

      for (const [slug, staleSessions] of staleBySlug) {
        const slugDir = join(projectsDir, slug);
        let files: string[];
        try { files = fs.readdirSync(slugDir); } catch { continue; }
        // Collect orphan transcripts (recently modified, not owned by any known session,
        // or owned but with pid=0 meaning it was registered as standalone without a process)
        const orphans: Array<{ sid: string; full: string; mtimeMs: number }> = [];
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const sid = file.replace('.jsonl', '');
          // Skip if it's a stale session itself (not an orphan)
          if (staleSessions.some(s => s.sessionId === sid)) continue;
          // Allow sessions with pid=0 (registered as standalone but unlinked)
          if (knownIds.has(sid)) {
            const existing = ctx.stateManager.getSession(sid);
            if (existing && existing.pid > 0) continue; // truly owned, skip
          }
          const full = join(slugDir, file);
          try {
            const stat = fs.statSync(full);
            if (!stat.isFile()) continue;
            if (Date.now() - stat.mtimeMs > 6 * 3600_000) continue; // still keep 6h window for orphans
            orphans.push({ sid, full, mtimeMs: stat.mtimeMs });
          } catch { /* skip */ }
        }
        if (orphans.length === 0) continue;

        // For each orphan, read its head and try to match to a stale session by ID reference
        for (const orphan of orphans) {
          let head = '';
          try {
            const fd = fs.openSync(orphan.full, 'r');
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            head = buf.toString('utf-8', 0, bytesRead);
          } catch { continue; }

          // Find which stale session this orphan references
          let match = staleSessions.find(s => head.includes(s.sessionId));

          if (!match) continue;

          console.log(`[transcript:startup] orphan ${orphan.sid.slice(0, 8)} references stale ${match.sessionId.slice(0, 8)} — replacing`);
          const clearName = ctx.stateManager.getSession(match.sessionId)?.proposedName ?? match.sessionId.slice(0, 8);
          closeOrRemoveReplaced(ctx.sessionCtx, match.sessionId);
          // Undelete in case the orphan was previously deleted (e.g. by an earlier aggressive scan)
          ctx.stateManager.undelete(orphan.sid);
          // If the orphan was already registered as a standalone session (pid=0), remove it first
          // so addOrUpdate creates it fresh with the correct PID
          const existingOrphan = ctx.stateManager.getSession(orphan.sid);
          if (existingOrphan && existingOrphan.pid === 0) {
            ctx.stateManager.remove(orphan.sid);
          }
          ctx.stateManager.addOrUpdate({ sessionId: orphan.sid, pid: match.pid, cwd: match.cwd, startedAt: Date.now() });
          ctx.stateManager.transferName(match.sessionId, orphan.sid);
          migratePtyMaps(ctx.sessionCtx, match.sessionId, orphan.sid, match.pid);
          ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: match.sessionId, newSessionId: orphan.sid });
          log('clear:detected', 'Startup orphan clear detected', { sessionId: orphan.sid, sessionName: clearName, extra: match.sessionId.slice(0, 8) + ' → ' + orphan.sid.slice(0, 8) });
          knownIds.add(orphan.sid);
          break; // One replacement per orphan
        }
      }
    } catch (err) {
      console.log(`[transcript:startup] scan error: ${err}`);
    }
  }, 3000); // Delay so all session files are loaded first

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
              if (raw.sessionId !== sessionId && !ctx.stateManager.isDeleted(raw.sessionId)) {
                const clearName = sess2.proposedName ?? sessionId.slice(0, 8);
                closeOrRemoveReplaced(ctx.sessionCtx, sessionId);
                ctx.stateManager.addOrUpdate(raw);
                ctx.stateManager.transferName(sessionId, raw.sessionId);
                migratePtyMaps(ctx.sessionCtx, sessionId, raw.sessionId, sess2.pid);
                ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: sessionId, newSessionId: raw.sessionId });
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
      if (currentSession && !currentSession.isWorker && (currentSession.state === 'working' || currentSession.state === 'thinking') && !currentSession.currentTaskLabel && !ctx.aiClassifier.hasLabelScheduled(sessionId) && !ctx.aiClassifier.isGeneratingLabel(sessionId)) {
        ctx.aiClassifier.scheduleLabel(sessionId);
      }
    }
  }, 3_000);

  // Periodic cleanup of leaked PTY entries (every 60s)
  setInterval(() => {
    for (const [pid, entry] of ctx.pendingPtyByPid) {
      if (!ctx.ptyManager.has(entry.ptySessionId)) {
        ctx.pendingPtyByPid.delete(pid);
      }
    }
    // Clean up stale pendingPtyByResumeId entries (older than 60s or PTY no longer alive)
    const now = Date.now();
    for (const [resumeId, entry] of ctx.pendingPtyByResumeId) {
      if (now - entry.timestamp > 60_000 || !ctx.ptyManager.has(entry.ptySessionId)) {
        ctx.pendingPtyByResumeId.delete(resumeId);
      }
    }
  }, 60_000);
}
