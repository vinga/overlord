import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { Session, Room, OfficeSnapshot, WorkerState } from '../types.js';
import { log } from '../logger.js';
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

  constructor(onChange: () => void) {
    this.onChangeCallback = onChange;
    this.knownSessionsFile = path.join(os.homedir(), '.claude', 'overlord', 'known-sessions.json');
    this.loadAccepted();
    this.loadDeleted();
    this.loadKnownSessions();
    this.loadPendingResumes();
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
          launchMethod: (() => {
            const stored: Session['launchMethod'] = entry.launchMethod ?? 'terminal';
            if (stored !== 'overlord-pty' && stored !== 'overlord-resume') return stored;
            const pid = entry.pid ?? 0;
            if (pid > 0 && !this.isSpawnedByOverlord(pid)) {
              const ideInfo = this.readIdeInfo(entry.cwd ?? '');
              const isIde = ideInfo != null && this.isChildOfIde(pid, ideInfo.idePid);
              return isIde ? 'ide' : 'terminal';
            }
            return stored;
          })(),
          color,
          subagents: [],
          proposedName: entry.proposedName,
          resumedFrom: entry.resumedFrom,
          completionSummaries: entry.completionSummaries,
          userAccepted: entry.userAccepted,
        });
      }
      if (dirty) {
        fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
        fs.writeFileSync(this.knownSessionsFile, JSON.stringify(cleaned, null, 2));
      }
    } catch { /* ignore */ }
  }

  private saveKnownSessions(): void {
    try {
      fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
      const entries = [...this.sessions.values()]
        .filter(s => !s.isWorker)
        .map(s => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          launchMethod: s.launchMethod,
          startedAt: s.startedAt,
          pid: s.pid,
          proposedName: s.proposedName,
          resumedFrom: s.resumedFrom,
          completionSummaries: s.completionSummaries,
          userAccepted: s.userAccepted,
        }));
      fs.writeFileSync(this.knownSessionsFile, JSON.stringify(entries, null, 2));
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

    let state: WorkerState = existingSession?.state ?? 'waiting';
    let lastActivity = new Date().toISOString();
    let lastMessage: string | undefined;
    let activityFeed: import('../types.js').ActivityItem[] | undefined;
    let slug: string | undefined;
    let model: string | undefined;
    let inputTokens: number | undefined;
    let compactCount: number | undefined;
    let isCompacting: boolean | undefined;
    let needsPermission: boolean | undefined;

    // Check for a pending resume: if this session was just resumed from another, link them.
    // Resolved early so the transcript fallback below can use it.
    let resumedFrom: string | undefined;
    if (existingSession?.resumedFrom) {
      // Preserve already-linked resumedFrom on subsequent updates
      resumedFrom = existingSession.resumedFrom;
    } else {
      const pendingEntry = this.pendingResumes.get(normalizePath(cwd));
      if (pendingEntry && Date.now() - pendingEntry.timestamp < 60000) {
        resumedFrom = pendingEntry.resumeSessionId;
        this.pendingResumes.delete(normalizePath(cwd));
        this.savePendingResumes();
      }
    }

    let transcriptPath = findTranscriptPath(cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (transcriptPath) {
      const result = readTranscriptState(transcriptPath);
      state = result.state;
      lastActivity = result.lastActivity;
      lastMessage = result.lastMessage;
      activityFeed = result.activityFeed;
      model = result.model;
      inputTokens = result.inputTokens;
      compactCount = result.compactCount;
      isCompacting = result.isCompacting;
      needsPermission = result.needsPermission;
      slug = readSlug(transcriptPath);
    } else if (resumedFrom) {
      // claude --resume appends to the original transcript rather than creating a new one.
      // Fall back to reading the original session's transcript so the resumed session shows the
      // correct state instead of defaulting to "waiting".
      const fallbackPath = findTranscriptPath(cwd, resumedFrom) ?? findTranscriptPathAnywhere(resumedFrom);
      if (fallbackPath) {
        const result = readTranscriptState(fallbackPath);
        state = result.state;
        lastActivity = result.lastActivity;
        lastMessage = result.lastMessage;
        activityFeed = result.activityFeed;
        model = result.model;
        inputTokens = result.inputTokens;
        compactCount = result.compactCount;
        isCompacting = result.isCompacting;
        needsPermission = result.needsPermission;
        slug = readSlug(fallbackPath);
        // Use the fallback path for proposedName resolution below
        transcriptPath = fallbackPath;
      }
    }
    const rawName = raw.name?.includes('___OVR:') ? raw.name.split('___OVR:')[0] : raw.name;
    const proposedName = (rawName || undefined)
      ?? existingSession?.proposedName
      ?? (transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined)
      ?? (resumedFrom ? this.sessions.get(resumedFrom)?.proposedName : undefined);

    const subagents = readSubagents(cwd, sessionId);
    const color = this.sessionColor(sessionId);
    const ideInfo = this.readIdeInfo(cwd);
    // Only tag as IDE if the session process is actually a child of the IDE process
    const isIdeSession = ideInfo != null && raw.pid > 0 && this.isChildOfIde(raw.pid, ideInfo.idePid);
    const ideName = isIdeSession ? ideInfo.name : undefined;

    const isNew = !this.sessions.has(sessionId);

    // Determine launch method only on first creation; preserve it on subsequent updates.
    let launchMethod: Session['launchMethod'];
    if (isNew) {
      const pendingSpawnTs = this.pendingPtySpawns.get(normalizePath(cwd));
      const isPendingPtySpawn = pendingSpawnTs != null && Date.now() - pendingSpawnTs < 5000
        && (raw.pid === 0 || this.isSpawnedByOverlord(raw.pid));
      if (isPendingPtySpawn) {
        launchMethod = 'overlord-pty';
        this.pendingPtySpawns.delete(normalizePath(cwd));
      } else if (resumedFrom) {
        // Resumed via /clear or other detection — inherit the old session's launchMethod
        const origSession = this.sessions.get(resumedFrom);
        launchMethod = origSession?.launchMethod ?? 'terminal';
      } else if (isIdeSession) {
        launchMethod = 'ide';
      } else {
        launchMethod = 'terminal';
      }
    } else {
      const hasPendingPty = this.pendingPtySpawns.has(normalizePath(cwd)) || this.hasPendingResume(cwd);
      const pidChanged = raw.pid > 0 && existingSession!.pid > 0 && raw.pid !== existingSession!.pid;
      const wasClosedNowActive = existingSession!.state === 'closed' && state !== 'closed';
      // Re-evaluate launchMethod if the PID changed (session was resumed in a new process)
      // or if a closed PTY session became active again without a pending PTY spawn.
      const wasOverlordSession = existingSession!.launchMethod === 'overlord-pty'
        || existingSession!.launchMethod === 'overlord-resume';
      if (!hasPendingPty && (pidChanged || wasClosedNowActive) && wasOverlordSession) {
        // Re-check if this process is still Overlord-spawned; if not, correct the label
        const stillOverlord = raw.pid > 0 && this.isSpawnedByOverlord(raw.pid);
        if (!stillOverlord) {
          launchMethod = isIdeSession ? 'ide' : 'terminal';
        } else {
          launchMethod = existingSession!.launchMethod;
        }
      } else {
        launchMethod = existingSession!.launchMethod;
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
      lastMessage,
      activityFeed,
      model,
      inputTokens,
      compactCount,
      isCompacting,
      ideName,
      launchMethod,
      color,
      subagents,
      resumedFrom,
      needsPermission: needsPermission || existingSession?.needsPermission,
      permissionPromptText: needsPermission ? undefined : existingSession?.permissionPromptText,
      permissionApprovedAt: existingSession?.permissionApprovedAt,
      completionHint: state === 'waiting' ? (existingSession?.completionHint ?? (isNew ? loadCompletionHint(sessionId) : undefined)) : undefined,
      completionSummaries,
      userAccepted: this.acceptedSessions.has(sessionId) || existingSession?.userAccepted,
      isWorker: raw.kind === 'haiku-worker',
    };

    this.sessions.set(sessionId, session);
    if (isNew) {
      this.saveKnownSessions();
    }
    this.onChange();
    return { isNewWaiting: isNew && state === 'waiting', lastMessage };
  }

  remove(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      clearProposedNameCache(sessionId);
      this.saveKnownSessions();
      this.onChange();
    }
  }

  markClosed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state !== 'closed') {
      session.state = 'closed';
      this.onChange();
    }
  }

  setLaunchMethod(sessionId: string, method: Session['launchMethod']): void {
    const session = this.sessions.get(sessionId);
    if (session && session.launchMethod !== method) {
      this.sessions.set(sessionId, { ...session, launchMethod: method });
      this.onChange();
    }
  }

  transferName(oldSessionId: string, newSessionId: string): void {
    const oldSession = this.sessions.get(oldSessionId);
    const newSession = this.sessions.get(newSessionId);
    if (!oldSession || !newSession) return;
    if (!newSession.proposedName && oldSession.proposedName) {
      newSession.proposedName = oldSession.proposedName;
    }
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

    let transcriptPath = findTranscriptPath(session.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    // Forked sessions (clones) may not have their own transcript yet — fall back to parent's
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
        }
      }
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
      } else if (promptText && !session.permissionPromptText) {
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

  removePtySession(_sessionId: string): void {
    // No-op: sessions stay tracked in known-sessions.json as closed;
    // markDeleted() handles explicit removal when user deletes a session.
  }

  getPtySessionIds(): string[] {
    return [...this.sessions.values()]
      .filter(s => s.launchMethod === 'overlord-pty')
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
      .filter(s => s.launchMethod === 'overlord-pty' && s.state === 'closed')
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
            launchMethod: 'terminal', // historical recovery — can't verify IDE parentage
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
   *  is the intermediary, so the session was NOT launched by the IDE. */
  private isChildOfIde(sessionPid: number, idePid: number): boolean {
    let current = sessionPid;
    for (let i = 0; i < 3; i++) {
      let parentInfo: { pid: number; name: string } | null;
      if (this.parentPidCache.has(current)) {
        const cached = this.parentPidCache.get(current)!;
        parentInfo = cached != null ? { pid: cached, name: '' } : null;
      } else {
        try {
          const out = execSync(
            `powershell -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${current}' -ErrorAction SilentlyContinue; if ($p) { Write-Host \"$($p.ParentProcessId) $($p.Name)\" }"`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (out) {
            const [pidStr, ...nameParts] = out.split(' ');
            const pid = parseInt(pidStr, 10);
            parentInfo = !isNaN(pid) ? { pid, name: nameParts.join(' ').toLowerCase() } : null;
          } else {
            parentInfo = null;
          }
        } catch {
          parentInfo = null;
        }
        this.parentPidCache.set(current, parentInfo?.pid ?? null);
      }
      if (!parentInfo || parentInfo.pid === 0) return false;
      // If node.exe is in the chain, this session was spawned through Overlord — not the IDE
      if (parentInfo.name.startsWith('node')) return false;
      if (parentInfo.pid === idePid) return true;
      current = parentInfo.pid;
    }
    return false;
  }

  /** Check if sessionPid was spawned by Overlord (node.exe in parent chain within 2 hops) */
  private isSpawnedByOverlord(sessionPid: number): boolean {
    let current = sessionPid;
    for (let i = 0; i < 2; i++) {
      const cached = this.parentPidCache.get(current);
      let parentPid: number | null = cached !== undefined ? cached : null;
      let parentName = '';
      if (cached === undefined) {
        try {
          const out = execSync(
            `powershell -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${current}' -ErrorAction SilentlyContinue; if ($p) { Write-Host \"$($p.ParentProcessId) $($p.Name)\" }"`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (out) {
            const [pidStr, ...nameParts] = out.split(' ');
            const pid = parseInt(pidStr, 10);
            parentPid = !isNaN(pid) ? pid : null;
            parentName = nameParts.join(' ').toLowerCase();
          }
        } catch {
          parentPid = null;
        }
        this.parentPidCache.set(current, parentPid);
      }
      if (!parentPid) return false;
      // matches node.exe (Windows), node (Linux/Docker)
      if (parentName === 'node' || parentName === 'node.exe' || parentName.startsWith('node ')) return true;
      current = parentPid;
    }
    return false;
  }
}
