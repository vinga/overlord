import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { Session, Room, OfficeSnapshot, WorkerState } from '../types.js';
import { getBridgePath } from '../pty/pipeInjector.js';
import { log } from '../logger.js';

/**
 * Batch-query all process parent/name info in one OS call, then walk chains in JS.
 * Windows: single `Get-CimInstance Win32_Process` call.
 * macOS/Linux: single `ps -eo pid,ppid,comm` call.
 * Returns a lookup map: pid → { parentPid, name }.
 */
function getAllProcessInfo(): Map<number, { parentPid: number; name: string }> {
  const procMap = new Map<number, { parentPid: number; name: string }>();
  try {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name -EA SilentlyContinue | ForEach-Object { Write-Host "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf-8', timeout: 10000 }).trim();
      for (const line of out.split('\n')) {
        const parts = line.trim().split('|');
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const parentPid = parseInt(parts[1], 10);
          const name = parts[2].toLowerCase().trim();
          if (!isNaN(pid) && !isNaN(parentPid)) procMap.set(pid, { parentPid, name });
        }
      }
    } else {
      // macOS/Linux: ps is fast and universally available
      const out = execSync('ps -eo pid,ppid,comm', { encoding: 'utf-8', timeout: 5000 }).trim();
      for (const line of out.split('\n').slice(1)) { // skip header
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          const parentPid = parseInt(match[2], 10);
          const name = path.basename(match[3]).toLowerCase().trim();
          if (!isNaN(pid) && !isNaN(parentPid)) procMap.set(pid, { parentPid, name });
        }
      }
    }
  } catch { /* ignore — process checks are best-effort */ }
  return procMap;
}
import {
  findTranscriptPath,
  findTranscriptPathAnywhere,
  readTranscriptState,
  readSubagents,
  readSlug,
  readProposedName,
  clearProposedNameCache,
} from './transcriptReader.js';
import type { RawSession } from './sessionWatcher.js';
import { readTaskSummaries, acceptTaskSummary, saveCompletionHint, loadCompletionHint, clearCompletionHint } from '../ai/taskStorage.js';
import type { TaskSummary } from '../ai/taskStorage.js';

function normalizePath(p: string): string {
  // Convert WSL path /mnt/c/... to c:/...
  const wslMatch = p.match(/^\/mnt\/([a-z])\/(.*)/i);
  if (wslMatch) return `${wslMatch[1]}:/${wslMatch[2]}`.toLowerCase();
  // Normalize backslashes and lowercase
  return p.replace(/\\/g, '/').toLowerCase();
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();
  private onChangeCallback: () => void;
  private onChangePending = false;
  private pendingResumes = new Map<string, { resumeSessionId: string; timestamp: number }>();
  private pendingPtySpawns: Map<string, number> = new Map(); // cwd → timestamp
  private acceptedSessions: Set<string> = new Set();
  private readonly acceptedFile = path.join(os.homedir(), '.claude', 'overlord-accepted.json');
  private readonly pendingResumesFile = path.join(os.homedir(), '.claude', 'overlord', 'pending-resumes.json');
  private deletedSessionIds: Set<string> = new Set();
  private readonly deletedFile = path.join(os.homedir(), '.claude', 'overlord', 'deleted-sessions.json');
  private knownSessionsFile: string;
  private ideNameCache = new Map<string, { mtimeMs: number; result: { name: string; idePid: number } | undefined }>();
  private parentPidCache = new Map<number, number | null>(); // sessionPid → parentPid
  /** Full process snapshot for fast chain walks — populated on startup, refreshed lazily. */
  private processSnapshot = new Map<number, { parentPid: number; name: string }>();
  private processSnapshotAge = 0;
  /** Sessions awaiting /clear replacement — transcript refresh is suppressed until replaced. */
  private pendingClearSessions = new Set<string>();
  private colorOverrides = new Map<string, string>(); // sessionId → color preserved across /clear
  /** Sessions that had /clear injected via UI — maps cwd → { sessionId, timestamp } for the next new transcript. */
  private pendingClearReplacements = new Map<string, { sessionId: string; timestamp: number }>();
  readonly bridgePath: string;

  constructor(onChange: () => void) {
    this.bridgePath = getBridgePath();
    this.onChangeCallback = onChange;
    this.knownSessionsFile = path.join(os.homedir(), '.claude', 'overlord', 'known-sessions.json');
    this.loadAccepted();
    this.loadDeleted();
    this.refreshProcessSnapshot(); // one OS call, populates parentPidCache for all processes
    this.loadKnownSessions();
    this.loadPendingResumes();
  }

  /** Refresh the full process snapshot (one OS call). */
  private refreshProcessSnapshot(): void {
    this.processSnapshot = getAllProcessInfo();
    this.processSnapshotAge = Date.now();
    // Populate the legacy parentPidCache from the snapshot
    for (const [pid, info] of this.processSnapshot) {
      this.parentPidCache.set(pid, info.parentPid);
    }
  }

  private onChange(): void {
    if (this.onChangePending) return;
    this.onChangePending = true;
    setImmediate(() => {
      this.onChangePending = false;
      this.onChangeCallback();
    });
  }

  private loadAccepted(): void {
    try {
      if (fs.existsSync(this.acceptedFile)) {
        const ids = JSON.parse(fs.readFileSync(this.acceptedFile, 'utf-8')) as string[];
        this.acceptedSessions = new Set(ids);
      }
    } catch { /* ignore */ }
  }

  private saveAccepted(): void {
    try {
      fs.writeFileSync(this.acceptedFile, JSON.stringify([...this.acceptedSessions]), 'utf-8');
    } catch { /* ignore */ }
  }

  private loadDeleted(): void {
    try {
      if (fs.existsSync(this.deletedFile)) {
        const ids = JSON.parse(fs.readFileSync(this.deletedFile, 'utf-8')) as string[];
        this.deletedSessionIds = new Set(ids);
      }
    } catch { /* ignore */ }
  }

  private loadPendingResumes(): void {
    try {
      if (!fs.existsSync(this.pendingResumesFile)) return;
      const data = JSON.parse(fs.readFileSync(this.pendingResumesFile, 'utf8'));
      if (!Array.isArray(data)) return;
      for (const entry of data) {
        if (entry.cwd && entry.resumeSessionId && entry.timestamp) {
          this.pendingResumes.set(normalizePath(entry.cwd), {
            resumeSessionId: entry.resumeSessionId,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch { /* ignore */ }
  }

  private savePendingResumes(): void {
    try {
      fs.mkdirSync(path.dirname(this.pendingResumesFile), { recursive: true });
      const data = [...this.pendingResumes.entries()].map(([cwd, entry]) => ({
        cwd,
        resumeSessionId: entry.resumeSessionId,
        timestamp: entry.timestamp,
      }));
      fs.writeFileSync(this.pendingResumesFile, JSON.stringify(data));
    } catch { /* ignore */ }
  }

  private loadKnownSessions(): void {
    try {
      if (!fs.existsSync(this.knownSessionsFile)) return;
      const data = JSON.parse(fs.readFileSync(this.knownSessionsFile, 'utf8'));
      if (!Array.isArray(data)) return;

      let dirty = false;
      const cleaned: typeof data = [];
      for (const entry of data) {
        if (!entry.sessionId || !entry.cwd) continue;
        if (this.deletedSessionIds.has(entry.sessionId) || entry.cwd.includes('haiku-worker')) {
          dirty = true;
          continue; // remove from file
        }
        // Purge <local-command-caveat> ghost sessions
        if ((entry.proposedName ?? entry.name ?? '').startsWith('<local-command-caveat')) {
          this.deletedSessionIds.add(entry.sessionId);
          dirty = true;
          continue;
        }
        cleaned.push(entry);
        // Pre-populate as closed; SessionWatcher will update active ones
        const color = this.sessionColor(entry.sessionId);
        this.sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          pid: entry.pid ?? 0,
          startedAt: entry.startedAt ?? Date.now(),
          state: 'closed',
          lastActivity: new Date(entry.startedAt ?? Date.now()).toISOString(),
          // On startup, re-evaluate Overlord-tagged sessions to catch misclassifications.
          // If the process is alive but NOT spawned by Overlord, correct the label now.
          sessionType: (() => {
            // Backward compat: map old launchMethod values to new sessionType
            let stored: Session['sessionType'];
            if (entry.sessionType) {
              stored = entry.sessionType;
            } else if (entry.launchMethod) {
              const lm = entry.launchMethod as string;
              if (lm === 'overlord-pty' || lm === 'overlord-resume') stored = 'embedded';
              else if (lm === 'ide') stored = 'ide';
              else stored = 'plain';
            } else {
              stored = 'plain';
            }
            if (stored !== 'embedded') return stored;
            const pid = entry.pid ?? 0;
            if (pid > 0 && !this.isSpawnedByOverlord(pid)) {
              const ideInfo = this.readIdeInfo(entry.cwd ?? '');
              const isIde = ideInfo != null && this.isChildOfIde(pid, ideInfo.idePid);
              return isIde ? 'ide' : 'plain';
            }
            return stored;
          })(),
          replacedBy: entry.replacedBy,
          color,
          subagents: [],
          proposedName: entry.proposedName,
          resumedFrom: entry.resumedFrom,
          completionSummaries: entry.completionSummaries,
          userAccepted: entry.userAccepted,
          bridgePipeName: entry.bridgePipeName,
          bridgeMarker: entry.bridgeMarker,
        });

        // Load transcript for closed sessions so conversation history is visible after restart
        let transcriptPath = findTranscriptPath(entry.cwd, entry.sessionId)
          ?? findTranscriptPathAnywhere(entry.sessionId);
        if (!transcriptPath && entry.resumedFrom) {
          transcriptPath = findTranscriptPath(entry.cwd, entry.resumedFrom) ?? findTranscriptPathAnywhere(entry.resumedFrom);
        }
        if (transcriptPath) {
          try {
            const result = readTranscriptState(transcriptPath);
            const s = this.sessions.get(entry.sessionId)!;
            s.activityFeed = result.activityFeed;
            if (result.lastActivity) s.lastActivity = result.lastActivity;
            // Do NOT override state — keep it 'closed'
          } catch { /* ignore */ }
        }
      }
      if (dirty) {
        fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
        fs.writeFileSync(this.knownSessionsFile, JSON.stringify(cleaned, null, 2));
      }
    } catch { /* ignore */ }

    // Migration: populate bridgePipeName from old registry file for sessions that don't have it yet
    try {
      const registryPath = path.join(os.tmpdir(), 'overlord-bridge-registry.json');
      if (fs.existsSync(registryPath)) {
        const oldRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
        let migrated = false;
        for (const [sessionId, pipeName] of Object.entries(oldRegistry)) {
          const session = this.sessions.get(sessionId);
          if (session && session.sessionType === 'bridge' && !session.bridgePipeName && pipeName) {
            session.bridgePipeName = pipeName;
            migrated = true;
          }
        }
        if (migrated) console.log('[stateManager] migrated bridge pipe names from old registry');
      }
    } catch { /* ignore */ }
  }

  /**
   * Detect /clear that happened while the server was down.
   * Compares known sessions' stored sessionId with the actual session file (keyed by PID).
   * If the PID file has a different sessionId, a /clear occurred — transfer state to the new session.
   * Must be called AFTER sessionWatcher.start() has loaded all session files via addOrUpdate.
   */
  detectClearOnStartup(): void {
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    for (const [oldSessionId, session] of this.sessions) {
      if (session.pid <= 0 || session.state === 'closed') continue;
      if (session.replacedBy) continue;
      // Read the actual session file for this PID
      const filePath = path.join(sessionsDir, `${session.pid}.json`);
      try {
        if (!fs.existsSync(filePath)) continue;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const currentSessionId = raw.sessionId as string;
        if (!currentSessionId || currentSessionId === oldSessionId) continue;
        if (this.deletedSessionIds.has(currentSessionId)) continue;
        // The PID file has a different sessionId — /clear happened while we were down
        const newSession = this.sessions.get(currentSessionId);
        if (!newSession) continue; // new session not yet registered (shouldn't happen after sessionWatcher.start)
        console.log(`[clear:startup] PID ${session.pid} changed: ${oldSessionId.slice(0, 8)} → ${currentSessionId.slice(0, 8)}`);
        this.transferSessionState(oldSessionId, currentSessionId);
        // Mark old session as replaced
        const old = this.sessions.get(oldSessionId);
        if (old) {
          old.state = 'closed';
          this.deletedSessionIds.add(oldSessionId);
        }
        this.onChange();
      } catch { /* ignore read errors */ }
    }
  }

  private saveKnownSessions(): void {
    try {
      fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
      const entries = [...this.sessions.values()]
        .filter(s => !s.isWorker && !s.cwd.toLowerCase().replace(/\\/g, '/').includes('/.claude/'))
        .map(s => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          sessionType: s.sessionType,
          replacedBy: s.replacedBy,
          startedAt: s.startedAt,
          pid: s.pid,
          proposedName: s.proposedName,
          resumedFrom: s.resumedFrom,
          completionSummaries: s.completionSummaries,
          userAccepted: s.userAccepted,
          bridgePipeName: s.bridgePipeName,
          bridgeMarker: s.bridgeMarker,
        }));
      fs.writeFileSync(this.knownSessionsFile, JSON.stringify(entries, null, 2));
      this.saveBridgeRegistry();
    } catch { /* ignore */ }
  }

  isDeleted(sessionId: string): boolean {
    return this.deletedSessionIds.has(sessionId);
  }

  undelete(sessionId: string): void {
    if (!this.deletedSessionIds.has(sessionId)) return;
    this.deletedSessionIds.delete(sessionId);
    try {
      fs.writeFileSync(this.deletedFile, JSON.stringify([...this.deletedSessionIds]), 'utf-8');
    } catch { /* ignore */ }
  }

  markDeleted(sessionId: string): void {
    this.deletedSessionIds.add(sessionId);
    try {
      const dir = path.dirname(this.deletedFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.deletedFile, JSON.stringify([...this.deletedSessionIds]), 'utf-8');
    } catch { /* ignore */ }
    clearProposedNameCache(sessionId);
    this.colorOverrides.delete(sessionId);
    this.sessions.delete(sessionId);
    this.saveKnownSessions();
    this.onChange();
  }

  acceptTask(sessionId: string, completedAt: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const updated = acceptTaskSummary(sessionId, completedAt);
    if (!updated) return false;
    session.completionSummaries = updated;
    this.onChange();
    return true;
  }

  acceptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.acceptedSessions.add(sessionId);
    session.userAccepted = true;
    this.saveAccepted();
    this.onChange();
    return true;
  }

  trackPendingResume(cwd: string, resumeSessionId: string): void {
    this.pendingResumes.set(normalizePath(cwd), { resumeSessionId, timestamp: Date.now() });
    this.savePendingResumes();
  }

  hasPendingResume(cwd: string): boolean {
    const entry = this.pendingResumes.get(normalizePath(cwd));
    return entry != null && Date.now() - entry.timestamp < 60000;
  }

  getPendingResumeTarget(cwd: string): string | undefined {
    const entry = this.pendingResumes.get(normalizePath(cwd));
    if (entry && Date.now() - entry.timestamp < 60000) return entry.resumeSessionId;
    return undefined;
  }

  trackPendingPtySpawn(cwd: string): void {
    this.pendingPtySpawns.set(normalizePath(cwd), Date.now());
  }

  addOrUpdate(raw: RawSession): { isNewWaiting: boolean; lastMessage?: string } {
    const { pid, sessionId, cwd, startedAt } = raw;

    // Skip sessions that were explicitly deleted by the user
    if (this.deletedSessionIds.has(sessionId)) {
      return { isNewWaiting: false };
    }

    const existingSession = this.sessions.get(sessionId);

    // Check for a pending resume: if this session was just resumed from another, link them.
    // Resolved early so the transcript fallback below can use it.
    let resumedFrom: string | undefined;
    if (existingSession?.resumedFrom) {
      resumedFrom = existingSession.resumedFrom;
    } else {
      const pendingEntry = this.pendingResumes.get(normalizePath(cwd));
      if (pendingEntry && Date.now() - pendingEntry.timestamp < 60000) {
        resumedFrom = pendingEntry.resumeSessionId;
        this.pendingResumes.delete(normalizePath(cwd));
        this.savePendingResumes();
      }
    }

    // Read transcript — own first, then fall back to resumed-from (for --resume which appends to parent)
    let transcriptPath = findTranscriptPath(cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath && resumedFrom) {
      transcriptPath = findTranscriptPath(cwd, resumedFrom) ?? findTranscriptPathAnywhere(resumedFrom);
    }

    const transcript = transcriptPath ? readTranscriptState(transcriptPath) : undefined;
    const slug = transcriptPath ? readSlug(transcriptPath) : undefined;

    const state = transcript?.state ?? existingSession?.state ?? 'waiting';
    const lastActivity = transcript?.lastActivity ?? new Date().toISOString();
    let rawName = raw.name?.includes('___OVR:') ? raw.name.split('___OVR:')[0] : raw.name;
    // Also strip bridge marker (___BRG:xxx) from display name
    if (rawName?.includes('___BRG:')) rawName = rawName.split('___BRG:')[0];
    const resolvedName = (rawName || undefined)
      ?? existingSession?.proposedName
      ?? (transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined)
      ?? (resumedFrom ? this.sessions.get(resumedFrom)?.proposedName : undefined);
    // Strip <local-command-caveat> prefix — treat it as no name so transferName can override
    const proposedName = resolvedName?.startsWith('<local-command-caveat') ? undefined : resolvedName;

    const subagents = readSubagents(cwd, sessionId);
    const color = this.sessionColor(sessionId);
    const ideInfo = this.readIdeInfo(cwd);
    // Only tag as IDE if the session process is actually a child of the IDE process
    const isIdeSession = ideInfo != null && raw.pid > 0 && this.isChildOfIde(raw.pid, ideInfo.idePid);
    const ideName = isIdeSession
      ? ideInfo.name
      : (raw.pid > 0 ? this.detectIdeFromProcessChain(raw.pid) : undefined);

    const isNew = !this.sessions.has(sessionId);

    // Determine session type only on first creation; preserve it on subsequent updates.
    let sessionType: Session['sessionType'];
    if (isNew) {
      const pendingSpawnTs = this.pendingPtySpawns.get(normalizePath(cwd));
      const isPendingPtySpawn = pendingSpawnTs != null && Date.now() - pendingSpawnTs < 5000
        && (raw.pid === 0 || this.isSpawnedByOverlord(raw.pid));
      if (isPendingPtySpawn) {
        sessionType = 'embedded';
        this.pendingPtySpawns.delete(normalizePath(cwd));
      } else if (resumedFrom) {
        // Resumed via /clear or other detection — inherit the old session's sessionType
        const origSession = this.sessions.get(resumedFrom);
        sessionType = origSession?.sessionType ?? 'plain';
      } else if (isIdeSession) {
        sessionType = 'ide';
      } else {
        sessionType = 'plain';
      }
    } else {
      const hasPendingPty = this.pendingPtySpawns.has(normalizePath(cwd)) || this.hasPendingResume(cwd);
      const pidChanged = raw.pid > 0 && existingSession!.pid > 0 && raw.pid !== existingSession!.pid;
      const wasClosedNowActive = existingSession!.state === 'closed' && state !== 'closed';
      // Re-evaluate sessionType if the PID changed (session was resumed in a new process)
      // or if a closed embedded session became active again without a pending PTY spawn.
      const wasEmbeddedSession = existingSession!.sessionType === 'embedded';
      if (!hasPendingPty && (pidChanged || wasClosedNowActive) && wasEmbeddedSession) {
        // Re-check if this process is still Overlord-spawned; if not, correct the label
        const stillOverlord = raw.pid > 0 && this.isSpawnedByOverlord(raw.pid);
        if (!stillOverlord) {
          sessionType = isIdeSession ? 'ide' : 'plain';
        } else {
          sessionType = existingSession!.sessionType;
        }
      } else {
        sessionType = existingSession!.sessionType;
      }
    }

    // Load persisted summaries on first encounter; preserve in-memory on updates.
    // If this is a resumed session, prepend parent's summaries so history carries over.
    let completionSummaries: TaskSummary[] | undefined;
    if (isNew) {
      const own = readTaskSummaries(sessionId);
      const parent = resumedFrom ? readTaskSummaries(resumedFrom) : [];
      const merged = [...parent, ...own];
      completionSummaries = merged.length > 0 ? merged : undefined;
    } else {
      completionSummaries = existingSession?.completionSummaries;
    }

    const session: Session = {
      sessionId,
      slug,
      proposedName,
      pid,
      startedAt,
      cwd,
      state,
      lastActivity,
      lastMessage: transcript?.lastMessage,
      activityFeed: transcript?.activityFeed,
      model: transcript?.model,
      inputTokens: transcript?.inputTokens,
      compactCount: transcript?.compactCount,
      isCompacting: transcript?.isCompacting,
      ideName,
      sessionType,
      color,
      subagents,
      resumedFrom,
      needsPermission: transcript?.needsPermission || existingSession?.needsPermission,
      permissionPromptText: transcript?.permissionPromptText || existingSession?.permissionPromptText,
      permissionMode: transcript?.permissionMode || existingSession?.permissionMode,
      permissionApprovedAt: existingSession?.permissionApprovedAt,
      pendingQuestion: transcript?.pendingQuestion ?? existingSession?.pendingQuestion,
      completionHint: state === 'waiting' ? (existingSession?.completionHint ?? (isNew ? loadCompletionHint(sessionId) : undefined)) : undefined,
      completionSummaries,
      userAccepted: this.acceptedSessions.has(sessionId) || existingSession?.userAccepted,
      isWorker: raw.kind === 'haiku-worker',
      bridgePipeName: existingSession?.bridgePipeName,
      bridgeMarker: existingSession?.bridgeMarker,
      ptySessionId: existingSession?.ptySessionId,
    };

    this.sessions.set(sessionId, session);
    if (isNew) {
      this.saveKnownSessions();
    }
    this.onChange();
    return { isNewWaiting: isNew && state === 'waiting', lastMessage: transcript?.lastMessage };
  }

  remove(sessionId: string): void {
    this.pendingClearSessions.delete(sessionId);
    this.colorOverrides.delete(sessionId);
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      clearProposedNameCache(sessionId);
      this.saveKnownSessions();
      this.onChange();
    }
  }

  markClosed(sessionId: string): void {
    this.pendingClearSessions.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session && session.state !== 'closed') {
      session.state = 'closed';
      this.onChange();
    }
  }

  setSessionType(sessionId: string, type: Session['sessionType']): void {
    const session = this.sessions.get(sessionId);
    if (session && session.sessionType !== type) {
      this.sessions.set(sessionId, { ...session, sessionType: type });
      this.onChange();
    }
  }

  /**
   * Revive a bridge session that was loaded as 'closed' from known-sessions on restart.
   * Called when the bridge pipe successfully reconnects — the process is still alive,
   * so we re-open the session to 'idle' and let transcriptWatcher/processChecker take over.
   */
  reviveClosedSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state === 'closed') {
      session.state = 'waiting';
      this.onChange();
      console.log(`[stateManager] revived closed session ${sessionId.slice(0, 8)} → waiting`);
    }
  }

  transferName(oldSessionId: string, newSessionId: string): void {
    this.transferSessionState(oldSessionId, newSessionId);
  }

  transferSessionState(oldSessionId: string, newSessionId: string): void {
    const oldSession = this.sessions.get(oldSessionId);
    const newSession = this.sessions.get(newSessionId);
    if (!oldSession || !newSession) return;
    // Treat <local-command-caveat> as a blank name — the old session's name should always win
    const newHasRealName = newSession.proposedName && !newSession.proposedName.startsWith('<local-command-caveat');
    if (!newHasRealName && oldSession.proposedName) {
      newSession.proposedName = oldSession.proposedName;
    }
    // Preserve color: carry over the old session's color (override or computed)
    const oldColor = this.colorOverrides.get(oldSessionId) ?? this.sessionColor(oldSessionId);
    this.colorOverrides.set(newSessionId, oldColor);
    // Also update the already-baked color field on the session object (addOrUpdate set it before transferSessionState ran)
    if (newSession) newSession.color = oldColor;
    // Transfer bridge/PTY connection metadata
    if (oldSession.bridgePipeName) newSession.bridgePipeName = oldSession.bridgePipeName;
    if (oldSession.bridgeMarker) newSession.bridgeMarker = oldSession.bridgeMarker;
    if (oldSession.ptySessionId) newSession.ptySessionId = oldSession.ptySessionId;
    if (oldSession.sessionType !== 'plain') newSession.sessionType = oldSession.sessionType;
    // Link to parent so transcript fallback, name resolution, and summaries carry over
    newSession.resumedFrom = oldSessionId;
    // Mark old session as replaced and clear its bridge/PTY state so it doesn't
    // appear in deriveBridgeRegistry() or cause pipe collisions on reconnect.
    oldSession.replacedBy = newSessionId;
    oldSession.bridgePipeName = undefined;
    oldSession.bridgeMarker = undefined;
    oldSession.ptySessionId = undefined;
    this.saveKnownSessions();
  }

  setBridgePipe(sessionId: string, pipeName: string, marker?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridgePipeName = pipeName;
    if (marker !== undefined) session.bridgeMarker = marker;
    this.saveKnownSessions();
    this.onChange();
  }

  isBridge(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.sessionType === 'bridge';
  }

  deriveBridgeRegistry(): Record<string, string> {
    const registry: Record<string, string> = {};
    for (const session of this.sessions.values()) {
      if (session.sessionType === 'bridge' && session.bridgePipeName) {
        registry[session.sessionId] = session.bridgePipeName;
      }
    }
    return registry;
  }

  private saveBridgeRegistry(): void {
    try {
      const registry = this.deriveBridgeRegistry();
      const registryPath = path.join(os.tmpdir(), 'overlord-bridge-registry.json');
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch { /* ignore */ }
  }

  setPid(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (session && session.pid !== pid) {
      session.pid = pid;
      this.onChange();
    }
  }

  refreshTranscript(sessionId: string): { becameWaiting: boolean; lastMessage?: string; becameWorking: boolean; leftWorking: boolean; transcriptStale: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };
    // Suppress re-read until /clear replacement is detected (prevents old transcript re-populating feed)
    if (this.pendingClearSessions.has(sessionId)) return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };

    let transcriptPath = findTranscriptPath(session.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath && session.resumedFrom) {
      transcriptPath = findTranscriptPath(session.cwd, session.resumedFrom) ?? findTranscriptPathAnywhere(session.resumedFrom);
    }
    if (!transcriptPath) return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };

    const prevState = session.state;
    const result = readTranscriptState(transcriptPath);
    const subagents = readSubagents(session.cwd, sessionId);
    const slug = session.slug ?? readSlug(transcriptPath);
    const proposedName = session.proposedName ?? readProposedName(sessionId, transcriptPath);

    let changed =
      session.state !== result.state ||
      session.lastActivity !== result.lastActivity ||
      session.lastMessage !== result.lastMessage ||
      JSON.stringify(session.activityFeed) !== JSON.stringify(result.activityFeed) ||
      session.model !== result.model ||
      session.inputTokens !== result.inputTokens ||
      session.compactCount !== result.compactCount ||
      session.isCompacting !== result.isCompacting ||
      session.needsPermission !== result.needsPermission ||
      session.slug !== slug ||
      session.proposedName !== proposedName ||
      JSON.stringify(session.subagents) !== JSON.stringify(subagents);

    if (changed) {
      // Clear completionHint when leaving waiting state
      if (prevState === 'waiting' && result.state !== 'waiting') {
        session.completionHint = undefined;
        session.completionHintByUser = false;
        clearCompletionHint(sessionId);
        session.userAccepted = undefined;
        this.acceptedSessions.delete(sessionId);
      }
      // Clear active task label when leaving working/thinking
      if ((prevState === 'working' || prevState === 'thinking') && result.state !== 'working' && result.state !== 'thinking') {
        session.currentTaskLabel = undefined;
      }
      // Log state transition
      if (prevState !== result.state) {
        const name = session.proposedName ?? sessionId.slice(0, 8);
        log('session:state', '', {
          sessionId,
          sessionName: name,
          extra: `${prevState} → ${result.state}`,
        });
      }
      session.state = result.state;
      session.lastActivity = result.lastActivity;
      session.lastMessage = result.lastMessage;
      session.activityFeed = result.activityFeed;
      session.model = result.model;
      session.inputTokens = result.inputTokens;
      session.compactCount = result.compactCount;
      session.isCompacting = result.isCompacting;
      // Only overwrite permissionMode from transcript if screen hasn't locked it recently
      if (result.permissionMode && !(session.permissionModeLockedUntil && Date.now() < session.permissionModeLockedUntil)) {
        session.permissionMode = result.permissionMode;
      }
      // Only update needsPermission from transcript when it clears (goes false).
      // Setting it true is owned by transcriptReader/addOrUpdate; clearing is also
      // done here when the session advances (transcript no longer shows stale tool_use).
      if (!result.needsPermission) {
        session.needsPermission = undefined;
        session.permissionPromptText = undefined;
      } else if (!session.needsPermission) {
        // Respect the 30s suppression window after user approved
        const suppressed = session.permissionApprovedAt &&
          Date.now() - session.permissionApprovedAt < 30_000;
        if (!suppressed) {
          session.needsPermission = result.needsPermission;
          if (result.permissionPromptText && !session.permissionPromptText) {
            session.permissionPromptText = result.permissionPromptText;
          }
        }
      }
      // Update pendingQuestion: set when present, clear when gone
      session.pendingQuestion = result.pendingQuestion ?? undefined;
      session.slug = slug;
      session.proposedName = proposedName;
      session.subagents = subagents;
    }

    // Clear manuallyDone when session is no longer in waiting state
    if (session.manuallyDone && result.state !== 'waiting') {
      session.manuallyDone = false;
      session.completionHintByUser = false;
      changed = true;
    }

    // User "DONE" command: immediately mark as done without Haiku classification
    if (result.lastUserIsDone) {
      if (session.completionHint !== 'done' || !session.completionHintByUser) {
        session.completionHint = 'done';
        session.completionHintByUser = true;
        changed = true;
      }
    } else if (session.completionHintByUser && !session.manuallyDone) {
      // User sent something other than DONE — clear the user-set hint
      session.completionHint = undefined;
      session.completionHintByUser = false;
      changed = true;
    }

    if (changed) {
      this.onChange();
    }

    // Stale transcript detection: track consecutive unchanged lastActivity for active sessions
    let transcriptStale = false;
    if (session.state === 'working' || session.state === 'thinking') {
      if (!changed || session.lastActivity === result.lastActivity) {
        session.staleCount = (session.staleCount ?? 0) + 1;
        if (session.staleCount >= 3) {
          transcriptStale = true;
          session.staleCount = 0; // reset so it triggers once, not repeatedly
        }
      } else {
        session.staleCount = 0;
      }
    } else {
      session.staleCount = 0;
    }

    const becameWaiting = prevState !== 'waiting' && result.state === 'waiting';
    const becameWorking = (prevState !== 'working' && prevState !== 'thinking') && (result.state === 'working' || result.state === 'thinking');
    const leftWorking = (prevState === 'working' || prevState === 'thinking') && (result.state !== 'working' && result.state !== 'thinking');
    return { becameWaiting, lastMessage: becameWaiting ? result.lastMessage : undefined, becameWorking, leftWorking, transcriptStale };
  }

  markDoneByUser(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return false;
    session.completionHint = 'done';
    session.completionHintByUser = true;
    session.manuallyDone = true;
    saveCompletionHint(sessionId, 'done');
    session.userAccepted = true;
    this.acceptedSessions.add(sessionId);
    this.saveAccepted();
    this.onChange();
    return true;
  }

  clearHintOnInput(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let changed = false;
    if (session.completionHint) {
      session.completionHint = undefined;
      session.completionHintByUser = false;
      session.userAccepted = undefined;
      this.acceptedSessions.delete(sessionId);
      this.saveAccepted();
      clearCompletionHint(sessionId);
      changed = true;
    }
    if (session.state === 'waiting') {
      session.state = 'working';
      changed = true;
    }
    if (changed) this.onChange();
  }

  setCompletionHint(sessionId: string, hint: 'done' | 'awaiting', forMessage: string): void {
    const session = this.sessions.get(sessionId);
    // Only apply if session is still waiting AND the last message hasn't changed
    if (
      session &&
      session.state === 'waiting' &&
      session.lastMessage === forMessage &&
      session.completionHint !== hint &&
      !session.completionHintByUser &&
      !session.manuallyDone &&
      !(session.completionHint === 'done' && hint === 'awaiting')
    ) {
      session.completionHint = hint;
      if (hint === 'done') saveCompletionHint(sessionId, 'done');
      this.onChange();
    }
  }

  setNeedsPermission(sessionId: string, value: boolean, promptText?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (value) {
      // Suppress re-detection for 30s after user approved
      if (session.permissionApprovedAt && Date.now() - session.permissionApprovedAt < 30_000) {
        return;
      }
      if (!session.needsPermission) {
        session.needsPermission = true;
        session.permissionPromptText = promptText;
        this.onChange();
      } else if (promptText && promptText !== session.permissionPromptText) {
        // Screen reader text is richer than transcript-derived text — always update
        session.permissionPromptText = promptText;
        this.onChange();
      }
    } else {
      session.permissionApprovedAt = Date.now();  // start suppression window
      if (session.needsPermission || session.permissionPromptText !== undefined) {
        session.needsPermission = undefined;
        session.permissionPromptText = undefined;
        this.onChange();
      }
    }
  }

  /** Called when /clear is injected. Immediately wipes the activity feed and blocks
   *  refreshTranscript from re-reading the old transcript until replacement is detected. */
  clearActivityFeed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pendingClearSessions.add(sessionId);
    session.activityFeed = [];
    session.pendingQuestion = undefined;
    session.lastMessage = undefined;
    this.onChange();
  }

  /** Record that /clear was injected into sessionId (via UI). The next new transcript
   *  in the same cwd will be linked as replacement. */
  markPendingClearReplacement(sessionId: string, cwd: string): void {
    const key = normalizePath(cwd);
    console.log(`[pending-clear] marked: ${sessionId.slice(0, 8)} key="${key}"`);
    this.pendingClearReplacements.set(key, { sessionId, timestamp: Date.now() });
  }

  /** Consume the pending clear replacement for cwd if it exists and is fresh (<60s). */
  consumePendingClearReplacement(cwd: string): { sessionId: string } | null {
    const key = normalizePath(cwd);
    const entry = this.pendingClearReplacements.get(key);
    console.log(`[pending-clear] consume key="${key}" found=${!!entry} keys=[${[...this.pendingClearReplacements.keys()].join(',')}]`);
    if (!entry) return null;
    this.pendingClearReplacements.delete(key);
    if (Date.now() - entry.timestamp > 60_000) return null;
    return { sessionId: entry.sessionId };
  }

  setCompletionSummaries(sessionId: string, summaries: TaskSummary[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completionSummaries = summaries;
      this.onChange();
    }
  }

  setCurrentTaskLabel(sessionId: string, label: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session && session.currentTaskLabel !== label) {
      session.currentTaskLabel = label;
      this.onChange();
    }
  }

  setPermissionMode(sessionId: string, mode: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // REVERT NOTE: original code only entered this block when mode changed:
    //   if (session && session.permissionMode !== mode) { session.permissionMode = mode; session.permissionModeLockedUntil = ...; this.onChange(); }
    //
    // CHANGE: For non-default modes, always refresh the lock — even if mode is unchanged.
    // This keeps the lock alive while repaints keep confirming the same mode,
    // preventing permissionChecker from flipping to 'default' between repaints.
    if (mode && mode !== 'default') {
      session.permissionModeLockedUntil = Date.now() + 15_000;
    }
    if (session.permissionMode !== mode) {
      session.permissionMode = mode;
      this.onChange();
    }
  }

  updateAlivePids(pids: Set<number>): void {
    let anyChanged = false;
    for (const session of this.sessions.values()) {
      if (!pids.has(session.pid) && session.state !== 'closed') {
        // Don't override transcript-based state if the session was recently active.
        // This prevents process-checker from fighting refreshTranscript when the PID
        // in the session file belongs to a shell/wrapper (e.g. IntelliJ terminal)
        // rather than the actual node process.
        const lastActivityAge = Date.now() - new Date(session.lastActivity).getTime();
        if (lastActivityAge > 30_000) {
          // Guard for ALL sessions: check transcript file mtime before closing.
          // The PID in the session file may belong to a shell/wrapper rather than
          // the actual node process, so verify the transcript isn't being written to.
          const transcriptPath = findTranscriptPath(session.cwd, session.sessionId)
            ?? findTranscriptPathAnywhere(session.sessionId);
          if (transcriptPath) {
            try {
              const stat = fs.statSync(transcriptPath);
              const transcriptAge = Date.now() - stat.mtimeMs;
              if (transcriptAge < 120_000) {
                continue; // transcript recently written — session likely still alive
              }
            } catch { /* file gone, proceed with closing */ }
          }
          session.state = 'closed';
          anyChanged = true;
        }
      }
    }
    if (anyChanged) {
      this.onChange();
    }
  }

  /**
   * Periodic GC: remove internal haiku-worker sessions (pid=0, cwd inside ~/.claude)
   * and close sessions that have been closed and inactive for >30 minutes.
   */
  cleanupStaleSessions(): void {
    const now = Date.now();
    const thirtyMin = 30 * 60 * 1000;
    let anyChanged = false;
    for (const [sessionId, session] of this.sessions) {
      // Remove haiku/internal worker sessions — they have pid=0 and cwd inside ~/.claude
      const cwdNorm = session.cwd.toLowerCase().replace(/\\/g, '/');
      if (cwdNorm.includes('/.claude/') && session.pid === 0) {
        this.sessions.delete(sessionId);
        this.colorOverrides.delete(sessionId);
        anyChanged = true;
        continue;
      }
      // Remove old closed sessions with no activity for >30 minutes
      if (session.state === 'closed' && session.pid === 0) {
        const lastActivityAge = now - new Date(session.lastActivity ?? session.startedAt).getTime();
        if (lastActivityAge > thirtyMin) {
          this.sessions.delete(sessionId);
          this.colorOverrides.delete(sessionId);
          anyChanged = true;
        }
      }
    }
    if (anyChanged) this.onChange();
  }

  removePtySession(_sessionId: string): void {
    // No-op: sessions stay tracked in known-sessions.json as closed;
    // markDeleted() handles explicit removal when user deletes a session.
  }

  getPtySessionIds(): string[] {
    return [...this.sessions.values()]
      .filter(s => s.sessionType === 'embedded')
      .map(s => s.sessionId);
  }

  getRootSessionId(sessionId: string): string {
    let current = sessionId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) break; // cycle guard
      visited.add(current);
      const session = this.sessions.get(current);
      if (!session?.resumedFrom) break;
      current = session.resumedFrom;
    }
    return current;
  }

  getPtySessionsToResume(): Array<{ sessionId: string; cwd: string }> {
    return [...this.sessions.values()]
      .filter(s => s.sessionType === 'embedded' && s.state === 'closed')
      .map(s => ({ sessionId: s.sessionId, cwd: s.cwd }));
  }

  getSnapshot(): OfficeSnapshot {
    const roomMap = new Map<string, Room>();

    for (const session of this.sessions.values()) {
      const { cwd } = session;
      if (!roomMap.has(cwd)) {
        const slug = cwd.replace(/[\\:/]/g, '-').replace(/^-+/, '');
        roomMap.set(cwd, {
          id: slug,
          name: cwd.endsWith('haiku-worker') ? 'Overlord AI' : (path.basename(cwd) || cwd),
          cwd,
          sessions: [],
        });
      }
      roomMap.get(cwd)!.sessions.push(session);
    }

    const rooms = Array.from(roomMap.values());

    // Sort rooms by name
    rooms.sort((a, b) => a.name.localeCompare(b.name));

    // Sort sessions within each room by startedAt
    for (const room of rooms) {
      room.sessions.sort((a, b) => a.startedAt - b.startedAt);
    }

    return {
      rooms,
      updatedAt: new Date().toISOString(),
      bridgePath: this.bridgePath,
    };
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  findSessionByPid(pid: number, excludeSessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.pid === pid && session.sessionId !== excludeSessionId) {
        return session;
      }
    }
    return undefined;
  }

  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  sessionColor(sessionId: string): string {
    if (this.colorOverrides.has(sessionId)) return this.colorOverrides.get(sessionId)!;
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    return `hsl(${hue}, 65%, 55%)`;
  }

  async loadClosedSessionsFromTranscripts(): Promise<void> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;

    const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const slug of slugDirs) {
      const slugDir = path.join(projectsDir, slug);
      let files: string[];
      try {
        files = fs.readdirSync(slugDir);
      } catch { continue; }

      for (const file of files) {
        // Only top-level UUID .jsonl files (not subagent subdirs)
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (!/^[0-9a-f-]{36}$/.test(sessionId)) continue;

        // Skip sessions already in state (active sessions)
        if (this.sessions.has(sessionId)) continue;

        // Skip sessions that are predecessors of already-known resumed sessions
        let isResumedPredecessor = false;
        for (const existing of this.sessions.values()) {
          if (existing.resumedFrom === sessionId) {
            isResumedPredecessor = true;
            break;
          }
        }
        if (isResumedPredecessor) continue;

        // Skip sessions that were explicitly deleted by the user
        if (this.deletedSessionIds.has(sessionId)) continue;

        const transcriptPath = path.join(slugDir, file);
        try {
          // Read cwd from first line that has it (first line is file-history-snapshot with no cwd)
          const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
          let cwd: string | undefined;
          for (const line of lines.slice(0, 10)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.cwd) { cwd = entry.cwd as string; break; }
            } catch { continue; }
          }
          if (!cwd) continue;

          // Skip internal Overlord worker sessions (cwd is inside ~/.claude/)
          const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/');
          if (cwdNorm.includes('/.claude/')) continue;

          // Read transcript state
          const transcriptState = readTranscriptState(transcriptPath);

          // Skip sessions inactive for more than 24 hours
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          if (transcriptState.lastActivity && new Date(transcriptState.lastActivity) < oneDayAgo) continue;

          const proposedName = readProposedName(sessionId, transcriptPath);
          const subagents = readSubagents(cwd, sessionId);
          const color = this.sessionColor(sessionId);

          // Recover startedAt from first transcript entry
          let startedAt = 0;
          for (const line of lines.slice(0, 5)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.timestamp) {
                startedAt = new Date(entry.timestamp).getTime();
                break;
              }
            } catch { continue; }
          }

          const session: Session = {
            sessionId,
            pid: 0,
            cwd,
            startedAt,
            state: 'closed',
            lastActivity: transcriptState.lastActivity,
            lastMessage: transcriptState.lastMessage,
            activityFeed: transcriptState.activityFeed,
            model: transcriptState.model,
            inputTokens: transcriptState.inputTokens,
            compactCount: transcriptState.compactCount,
            isCompacting: false,
            proposedName,
            ideName: undefined,
            sessionType: 'plain', // historical recovery — can't verify IDE parentage
            color,
            subagents,
            needsPermission: false,
          };

          this.sessions.set(sessionId, session);
        } catch {
          // Skip unreadable transcripts
          continue;
        }
      }
    }

    if (this.sessions.size > 0) {
      this.onChange();
    }
  }

  private readIdeInfo(cwd: string): { name: string; idePid: number } | undefined {
    const ideDir = path.join(os.homedir(), '.claude', 'ide');
    let dirMtime = 0;
    try {
      dirMtime = fs.statSync(ideDir).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = this.ideNameCache.get(ideDir);
    if (cached && cached.mtimeMs === dirMtime) return cached.result;

    let result: { name: string; idePid: number } | undefined;
    try {
      const files = fs.readdirSync(ideDir);
      const normalizedCwd = normalizePath(cwd);
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        try {
          const content = fs.readFileSync(path.join(ideDir, file), 'utf-8');
          const data = JSON.parse(content) as { workspaceFolders?: string[]; ideName?: string; pid?: number };
          if (data.ideName && Array.isArray(data.workspaceFolders) && data.pid) {
            const match = data.workspaceFolders.some(
              (folder) => normalizePath(folder) === normalizedCwd
            );
            if (match) {
              result = { name: data.ideName, idePid: data.pid };
              break;
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
    this.ideNameCache.set(ideDir, { mtimeMs: dirMtime, result });
    return result;
  }

  /** Check if sessionPid is a direct child of idePid (max 3 levels).
   *  Stops early if node.exe is found in the chain — that means Overlord
   *  is the intermediary, so the session was NOT launched by the IDE.
   *  Uses the process snapshot for fast lookups (no per-PID OS calls). */
  private isChildOfIde(sessionPid: number, idePid: number): boolean {
    let current = sessionPid;
    for (let i = 0; i < 3; i++) {
      const info = this.processSnapshot.get(current) ?? this.getProcessInfoFallback(current);
      if (!info || info.parentPid === 0) return false;
      if (info.name.startsWith('node')) return false;
      if (info.parentPid === idePid) return true;
      current = info.parentPid;
    }
    return false;
  }

  private static readonly IDE_PROCESS_NAMES: Record<string, string> = {
    'idea64.exe': 'IntelliJ IDEA',
    'idea.exe': 'IntelliJ IDEA',
    'code.exe': 'VS Code',
    'clion64.exe': 'CLion',
    'clion.exe': 'CLion',
    'webstorm64.exe': 'WebStorm',
    'webstorm.exe': 'WebStorm',
    'pycharm64.exe': 'PyCharm',
    'pycharm.exe': 'PyCharm',
    'rider64.exe': 'Rider',
    'rider.exe': 'Rider',
    'goland64.exe': 'GoLand',
    'goland.exe': 'GoLand',
    'datagrip64.exe': 'DataGrip',
    'datagrip.exe': 'DataGrip',
  };

  /** Walk the parent process chain (up to 6 hops) to detect a known IDE ancestor.
   *  Returns the IDE display name if found, undefined otherwise.
   *  Uses the process snapshot for fast lookups (no per-PID OS calls). */
  private detectIdeFromProcessChain(pid: number): string | undefined {
    let current = pid;
    for (let i = 0; i < 6; i++) {
      const info = this.processSnapshot.get(current) ?? this.getProcessInfoFallback(current);
      if (!info || info.parentPid === 0) return undefined;
      const ideName = StateManager.IDE_PROCESS_NAMES[info.name];
      if (ideName) return ideName;
      current = info.parentPid;
    }
    return undefined;
  }

  /** Check if sessionPid was spawned by Overlord (node.exe in parent chain within 2 hops).
   *  Uses the process snapshot for fast lookups (no per-PID OS calls). */
  private isSpawnedByOverlord(sessionPid: number): boolean {
    let current = sessionPid;
    for (let i = 0; i < 2; i++) {
      const info = this.processSnapshot.get(current) ?? this.getProcessInfoFallback(current);
      if (!info || info.parentPid === 0) return false;
      // Check the parent process name — Overlord runs as node.exe
      const parentName = (this.processSnapshot.get(info.parentPid) ?? this.getProcessInfoFallback(info.parentPid))?.name ?? '';
      if (parentName === 'node' || parentName === 'node.exe' || parentName.startsWith('node ')) return true;
      current = info.parentPid;
    }
    return false;
  }

  /** Fallback: query a single PID if it's not in the snapshot (process started after snapshot).
   *  Caches the result in the snapshot to avoid repeated lookups. */
  private getProcessInfoFallback(pid: number): { parentPid: number; name: string } | null {
    if (this.processSnapshot.has(pid)) return this.processSnapshot.get(pid)!;
    try {
      let out: string;
      if (process.platform === 'win32') {
        out = execSync(
          `powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -EA SilentlyContinue; if ($p) { Write-Host \\"$($p.ParentProcessId)|$($p.Name)\\" }"`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim();
      } else {
        out = execSync(`ps -p ${pid} -o ppid=,comm=`, { encoding: 'utf-8', timeout: 2000 }).trim();
        if (out) {
          const match = out.match(/^\s*(\d+)\s+(.+)$/);
          if (match) out = `${match[1]}|${path.basename(match[2])}`;
          else out = '';
        }
      }
      if (out) {
        const parts = out.split('|');
        if (parts.length >= 2) {
          const parentPid = parseInt(parts[0], 10);
          const name = parts[1].toLowerCase().trim();
          if (!isNaN(parentPid)) {
            const info = { parentPid, name };
            this.processSnapshot.set(pid, info);
            this.parentPidCache.set(pid, parentPid);
            return info;
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }
}
