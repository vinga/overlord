import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Session, Room, OfficeSnapshot, WorkerState } from './types.js';
import {
  findTranscriptPath,
  findTranscriptPathAnywhere,
  readTranscriptState,
  readSubagents,
  readSlug,
  readProposedName,
} from './transcriptReader.js';
import type { RawSession } from './sessionWatcher.js';
import { readTaskSummaries, acceptTaskSummary, saveCompletionHint, loadCompletionHint, clearCompletionHint } from './taskStorage.js';
import type { TaskSummary } from './taskStorage.js';

function normalizePath(p: string): string {
  // Convert WSL path /mnt/c/... to c:/...
  const wslMatch = p.match(/^\/mnt\/([a-z])\/(.*)/i);
  if (wslMatch) return `${wslMatch[1]}:/${wslMatch[2]}`.toLowerCase();
  // Normalize backslashes and lowercase
  return p.replace(/\\/g, '/').toLowerCase();
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();
  private onChange: () => void;
  private pendingResumes = new Map<string, { resumeSessionId: string; timestamp: number }>();
  private acceptedSessions: Set<string> = new Set();
  private readonly acceptedFile = path.join(os.homedir(), '.claude', 'overlord-accepted.json');
  private deletedSessionIds: Set<string> = new Set();
  private readonly deletedFile = path.join(os.homedir(), '.claude', 'overlord', 'deleted-sessions.json');

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.loadAccepted();
    this.loadDeleted();
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

  markDeleted(sessionId: string): void {
    this.deletedSessionIds.add(sessionId);
    try {
      const dir = path.dirname(this.deletedFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.deletedFile, JSON.stringify([...this.deletedSessionIds]), 'utf-8');
    } catch { /* ignore */ }
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
    this.pendingResumes.set(cwd, { resumeSessionId, timestamp: Date.now() });
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
    let activityFeed: import('./types.js').ActivityItem[] | undefined;
    let slug: string | undefined;
    let model: string | undefined;
    let inputTokens: number | undefined;
    let compactCount: number | undefined;
    let isCompacting: boolean | undefined;
    let needsPermission: boolean | undefined;

    const transcriptPath = findTranscriptPath(cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
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
    }
    const proposedName = (transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined)
      ?? existingSession?.proposedName;

    const subagents = readSubagents(cwd, sessionId);
    const color = this.sessionColor(sessionId);
    const ideName = this.readIdeName(cwd);

    // Check for a pending resume: if this session was just resumed from another, link them.
    let resumedFrom: string | undefined;
    if (existingSession?.resumedFrom) {
      // Preserve already-linked resumedFrom on subsequent updates
      resumedFrom = existingSession.resumedFrom;
    } else {
      const pendingEntry = this.pendingResumes.get(cwd);
      if (pendingEntry && Date.now() - pendingEntry.timestamp < 5000) {
        resumedFrom = pendingEntry.resumeSessionId;
        this.pendingResumes.delete(cwd);
      }
    }

    const isNew = !this.sessions.has(sessionId);

    // Determine launch method only on first creation; preserve it on subsequent updates.
    let launchMethod: Session['launchMethod'];
    if (isNew) {
      const pendingEntry = this.pendingResumes.get(cwd);
      if (pendingEntry && Date.now() - pendingEntry.timestamp < 5000) {
        launchMethod = 'overlord-pty';
      } else if (ideName) {
        launchMethod = 'ide';
      } else {
        launchMethod = 'terminal';
      }
    } else {
      launchMethod = existingSession!.launchMethod;
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
    this.onChange();
    return { isNewWaiting: isNew && state === 'waiting', lastMessage };
  }

  remove(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
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

  refreshTranscript(sessionId: string): { becameWaiting: boolean; lastMessage?: string; becameWorking: boolean; leftWorking: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return { becameWaiting: false, becameWorking: false, leftWorking: false };

    const transcriptPath = findTranscriptPath(session.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) return { becameWaiting: false, becameWorking: false, leftWorking: false };

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

    const becameWaiting = prevState !== 'waiting' && result.state === 'waiting';
    const becameWorking = (prevState !== 'working' && prevState !== 'thinking') && (result.state === 'working' || result.state === 'thinking');
    const leftWorking = (prevState === 'working' || prevState === 'thinking') && (result.state !== 'working' && result.state !== 'thinking');
    return { becameWaiting, lastMessage: becameWaiting ? result.lastMessage : undefined, becameWorking, leftWorking };
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
          session.state = 'closed';
          anyChanged = true;
        }
      }
    }
    if (anyChanged) {
      this.onChange();
    }
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

          const session: Session = {
            sessionId,
            pid: 0,
            cwd,
            startedAt: 0,
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
            launchMethod: 'terminal',
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

  private readIdeName(cwd: string): string | undefined {
    const ideDir = path.join(os.homedir(), '.claude', 'ide');
    try {
      if (!fs.existsSync(ideDir)) return undefined;
      const files = fs.readdirSync(ideDir);
      const normalizedCwd = normalizePath(cwd);
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        try {
          const content = fs.readFileSync(path.join(ideDir, file), 'utf-8');
          const data = JSON.parse(content) as { workspaceFolders?: string[]; ideName?: string };
          if (data.ideName && Array.isArray(data.workspaceFolders)) {
            const match = data.workspaceFolders.some(
              (folder) => normalizePath(folder) === normalizedCwd
            );
            if (match) return data.ideName;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }
}
