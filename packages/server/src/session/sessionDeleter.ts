import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { findTranscriptPathAnywhere } from './transcriptReader.js';
import { deleteLog as deleteShellHistoryLog } from '../pty/shellHistoryLog.js';
import { sessionStore } from './sessionStore.js';
import { bridgeManager } from '../pty/pipeInjector.js';
import { log } from '../logger.js';
import { appendDeletionAudit } from './deletionAudit.js';
import type { Session } from '../types.js';

interface StateManagerDep {
  getSession: (sessionId: string) => Session | undefined;
  isBridge: (sessionId: string) => boolean;
  markDeleted: (sessionId: string) => void;
  remove: (sessionId: string) => void;
  purgeOvrId: (ovrId: string) => string[];
  setBridgeActive: (sessionId: string, active: boolean) => void;
}

interface PtyManagerDep {
  kill: (ptyId: string) => void;
}

export interface SessionDeleterDeps {
  stateManager: StateManagerDep;
  ptyManager: PtyManagerDep;
  ovrToPty: Map<string, string>;
  ptyToOvr: Map<string, string>;
  bridgePermText: Map<string, string>;
  bridgePermMode: Map<string, string>;
  linkedBridgeSessions: Set<string>;
  bridgeIdOverrides: Map<string, string>;
}

/** Delete a session: in-memory state first (drives snapshot broadcast),
 *  then process kill + file I/O deferred via setImmediate so the broadcast
 *  fires before disk operations. */
export function deleteSession(
  deps: SessionDeleterDeps,
  sessionId: string,
  pid?: number,
  reason?: string,
): void {
  const { stateManager, ptyManager, ovrToPty, ptyToOvr, bridgePermText, bridgePermMode, linkedBridgeSessions, bridgeIdOverrides } = deps;
  const caller = reason ?? new Error().stack?.split('\n')[2]?.trim() ?? 'unknown';
  log('session:killed', `Session deleted (${caller})`, { sessionId, sessionName: sessionId.slice(0, 8), extra: pid ? `PID ${pid}` : 'no PID' });
  console.log(`[deleteSession] sessionId=${sessionId} pid=${pid} reason=${caller}`);

  // Capture refs that later cleanup needs — stateManager.remove wipes them.
  const existing = stateManager.getSession(sessionId);
  const ovrId = existing?.overlordId;
  const ptyId = ovrId ? ovrToPty.get(ovrId) : undefined;
  const wasBridge = stateManager.isBridge(sessionId);

  // FAST PATH — in-memory state updates that drive the snapshot broadcast.
  // Sweep every Session sharing this ovrId — predecessors from
  // transferSessionState (compaction / resume sid changes) linger as
  // replacedBy ghosts and would re-surface as closed once the live sid is gone.
  const purgedSids = ovrId ? stateManager.purgeOvrId(ovrId) : [];
  if (!purgedSids.includes(sessionId)) {
    stateManager.markDeleted(sessionId);
    stateManager.remove(sessionId);
  }
  console.log(`[deleteSession] removed ${sessionId} from state (purged sids: ${purgedSids.join(',') || sessionId})`);

  if (ptyId && ovrId) {
    ovrToPty.delete(ovrId);
    ptyToOvr.delete(ptyId);
    ptyManager.kill(ptyId);
    console.log(`[deleteSession] cleaned up PTY maps ovrId=${ovrId} pty=${ptyId}`);
  }

  if (wasBridge) {
    bridgeManager.disconnect(sessionId);
    bridgePermText.delete(sessionId); bridgePermMode.delete(sessionId);
    stateManager.setBridgeActive(sessionId, false);
    linkedBridgeSessions.delete(sessionId);
    bridgeIdOverrides.delete(sessionId);
    for (const [k, v] of bridgeIdOverrides) {
      if (v === sessionId) bridgeIdOverrides.delete(k);
    }
    console.log(`[deleteSession] cleaned up bridge state for ${sessionId.slice(0, 8)}`);
  }

  // SLOW PATH — process kill + file I/O deferred so the snapshot broadcast
  // (queued by stateManager.remove via setImmediate) fires first.
  setImmediate(() => {
    if (pid) {
      try {
        try { execSync(`pkill -P ${pid}`, { stdio: 'ignore' }); } catch { /* no children */ }
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
        console.log(`[deleteSession] killed pid=${pid} via kill -9`);
      } catch {
        // Process already dead — fine
      }
    }

    const sessionFile = join(os.homedir(), '.claude', 'sessions', `${sessionId}.json`);
    try {
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        console.log(`[deleteSession] deleted ${sessionFile}`);
      }
    } catch (err) {
      console.warn(`[deleteSession] failed to delete file for ${sessionId}:`, (err as Error).message);
    }

    // Walk every sid in the OverlordSession's lineage and unlink each canonical
    // transcript. Without this, historical sids (resumed/forked/post-/clear)
    // remain as orphan .jsonl files in ~/.claude/projects/<slug>/ and are
    // re-imported as fresh closed sessions on next boot by
    // loadClosedSessionsFromTranscripts.
    const storeRec = sessionStore.getBySessionId(sessionId);
    const sidsToWipe = new Set<string>([sessionId, ...purgedSids]);
    if (storeRec?.lineage) {
      sidsToWipe.add(storeRec.lineage.currentSessionId);
      for (const h of storeRec.lineage.history) sidsToWipe.add(h.sessionId);
    }

    // Resolve transcript paths first, then write the audit line BEFORE unlinking,
    // so a vanished session is recoverable even if an unlink throws.
    const sidTranscripts = [...sidsToWipe].map(
      (sid) => [sid, findTranscriptPathAnywhere(sid)] as const,
    );
    appendDeletionAudit({
      sessionId,
      ovrId,
      reason: caller,
      pid,
      purgedSids,
      lineageSids: [...sidsToWipe],
      transcriptPaths: sidTranscripts.map(([, p]) => p).filter((p): p is string => !!p),
      proposedName: storeRec?.proposedName,
    });

    for (const [sid, transcriptFile] of sidTranscripts) {
      if (transcriptFile) {
        try {
          fs.unlinkSync(transcriptFile);
          console.log(`[deleteSession] deleted transcript ${transcriptFile}`);
        } catch (err) {
          console.warn(`[deleteSession] failed to delete transcript for ${sid}:`, (err as Error).message);
        }
      }
    }

    try {
      const projectsBase = join(os.homedir(), '.claude', 'projects');
      if (fs.existsSync(projectsBase)) {
        for (const slug of fs.readdirSync(projectsBase)) {
          const sessionSubdir = join(projectsBase, slug, sessionId);
          if (fs.existsSync(sessionSubdir)) {
            fs.rmSync(sessionSubdir, { recursive: true, force: true });
            console.log(`[deleteSession] deleted subdir ${sessionSubdir}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[deleteSession] failed to delete session subdir for ${sessionId}:`, (err as Error).message);
    }

    const tasksBase = join(os.homedir(), '.claude', 'overlord', 'tasks', sessionId);
    for (const ext of ['.json', '.hint']) {
      const p = `${tasksBase}${ext}`;
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          console.log(`[deleteSession] deleted task file ${p}`);
        }
      } catch (err) {
        console.warn(`[deleteSession] failed to delete task file ${p}:`, (err as Error).message);
      }
    }

    try {
      deleteShellHistoryLog(sessionId);
    } catch (err) {
      console.warn(`[deleteSession] failed to delete shell history for ${sessionId}:`, (err as Error).message);
    }

    // Drop the OverlordSession record unless it was just archived
    // (archive must survive deleteSession).
    if (!storeRec?.archive) sessionStore.removeBySessionId(sessionId);
  });
}
