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
    const { sessionId } = parsed;
    const existing = transcriptDebounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    transcriptDebounceTimers.set(sessionId, setTimeout(() => {
      transcriptDebounceTimers.delete(sessionId);
      ctx.stateManager.refreshTranscript(sessionId);
    }, 150));
  }

  // Handle new .jsonl files appearing — detect /clear session replacement
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

    // Unknown session: read cwd from the transcript to detect /clear replacement
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

      if (!cwd) {
        // No cwd found yet — let normal flow handle it
        handleTranscriptFile(filePath);
        return;
      }

      // Find the most recently active non-closed session in the same CWD — that's the cleared one.
      const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
      let bestSession: { sessionId: string; pid: number; isWorker?: boolean } | null = null;
      let bestActivity = -Infinity;

      for (const sid of ctx.stateManager.getAllSessionIds()) {
        if (sid === newSessionId) continue;
        const s = ctx.stateManager.getSession(sid);
        if (!s || s.state === 'closed') continue;
        if (s.cwd.replace(/\\/g, '/').toLowerCase() !== normalizedCwd) continue;
        const t = new Date(s.lastActivity).getTime();
        if (t > bestActivity) {
          bestActivity = t;
          bestSession = { sessionId: sid, pid: s.pid, isWorker: s.isWorker };
        }
      }

      // Skip /clear detection if a PTY resume is in progress — interim sessions are not /clear replacements
      if (hasActiveResumeInProgress(ctx.sessionCtx)) {
        console.log(`[transcript:add] skipping /clear detection for ${newSessionId.slice(0, 8)} — PTY resume in progress`);
        handleTranscriptFile(filePath);
        return;
      }

      if (bestSession !== null) {
        closeOrRemoveReplaced(ctx.sessionCtx, bestSession.sessionId);
        ctx.stateManager.addOrUpdate({
          sessionId: newSessionId,
          pid: bestSession.pid,
          cwd,
          startedAt: Date.now(),
          kind: bestSession.isWorker ? 'haiku-worker' : undefined,
        });
        ctx.stateManager.transferName(bestSession.sessionId, newSessionId);
        migratePtyMaps(ctx.sessionCtx, bestSession.sessionId, newSessionId);
        ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: bestSession.sessionId, newSessionId });
        const clearName3 = ctx.stateManager.getSession(newSessionId)?.proposedName ?? newSessionId.slice(0, 8);
        log('clear:detected', 'Clear detected', { sessionId: newSessionId, sessionName: clearName3, extra: bestSession.sessionId.slice(0, 8) + ' → ' + newSessionId.slice(0, 8) });
        console.log(`[transcript:add] /clear detected: ${bestSession.sessionId} → ${newSessionId} (cwd: ${cwd})`);
      } else {
        // No matching session found — register as new standalone session
        ctx.stateManager.addOrUpdate({
          sessionId: newSessionId,
          pid: 0,
          cwd,
          startedAt: Date.now(),
        });
        console.log(`[transcript:add] new standalone session: ${newSessionId} (cwd: ${cwd})`);
      }
    } catch {
      // If we can't read the file yet, fall through to the normal handler
    }

    // Always let the normal refresh flow run so the new session gets registered
    handleTranscriptFile(filePath);
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
        if (lastActivityAge > 3600_000) {
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
            if (Date.now() - stat.mtimeMs > 6 * 3600_000) continue;
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
          const match = staleSessions.find(s => head.includes(s.sessionId));
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
              if (raw.sessionId !== sessionId) {
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
