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

export class StateManager {
  private sessions: Map<string, Session> = new Map();
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  addOrUpdate(raw: RawSession): void {
    const { pid, sessionId, cwd, startedAt } = raw;

    let state: WorkerState = 'idle';
    let lastActivity = new Date().toISOString();
    let lastMessage: string | undefined;
    let activityFeed: import('./types.js').ActivityItem[] | undefined;
    let slug: string | undefined;
    let model: string | undefined;
    let inputTokens: number | undefined;
    let compactCount: number | undefined;
    let isCompacting: boolean | undefined;

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
      slug = readSlug(transcriptPath);
    }

    const proposedName = transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined;

    const subagents = readSubagents(cwd, sessionId);
    const color = this.sessionColor(sessionId);
    const ideName = this.readIdeName(pid);

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
      color,
      subagents,
    };

    this.sessions.set(sessionId, session);
    this.onChange();
  }

  remove(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      this.onChange();
    }
  }

  markIdle(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state !== 'idle') {
      session.state = 'idle';
      this.onChange();
    }
  }

  refreshTranscript(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const transcriptPath = findTranscriptPath(session.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) return;

    const result = readTranscriptState(transcriptPath);
    const subagents = readSubagents(session.cwd, sessionId);
    const slug = session.slug ?? readSlug(transcriptPath);
    const proposedName = session.proposedName ?? readProposedName(sessionId, transcriptPath);

    const changed =
      session.state !== result.state ||
      session.lastActivity !== result.lastActivity ||
      session.lastMessage !== result.lastMessage ||
      JSON.stringify(session.activityFeed) !== JSON.stringify(result.activityFeed) ||
      session.model !== result.model ||
      session.inputTokens !== result.inputTokens ||
      session.compactCount !== result.compactCount ||
      session.isCompacting !== result.isCompacting ||
      session.slug !== slug ||
      session.proposedName !== proposedName ||
      JSON.stringify(session.subagents) !== JSON.stringify(subagents);

    if (changed) {
      session.state = result.state;
      session.lastActivity = result.lastActivity;
      session.lastMessage = result.lastMessage;
      session.activityFeed = result.activityFeed;
      session.model = result.model;
      session.inputTokens = result.inputTokens;
      session.compactCount = result.compactCount;
      session.isCompacting = result.isCompacting;
      session.slug = slug;
      session.proposedName = proposedName;
      session.subagents = subagents;
      this.onChange();
    }
  }

  updateAlivePids(pids: Set<number>): void {
    let anyChanged = false;
    for (const session of this.sessions.values()) {
      if (!pids.has(session.pid) && session.state !== 'idle') {
        // Don't override transcript-based state if the session was recently active.
        // This prevents process-checker from fighting refreshTranscript when the PID
        // in the session file belongs to a shell/wrapper (e.g. IntelliJ terminal)
        // rather than the actual node process.
        const lastActivityAge = Date.now() - new Date(session.lastActivity).getTime();
        if (lastActivityAge > 30_000) {
          session.state = 'idle';
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
          name: path.basename(cwd) || cwd,
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

  private readIdeName(pid: number): string | undefined {
    const ideDir = path.join(os.homedir(), '.claude', 'ide');
    try {
      if (!fs.existsSync(ideDir)) return undefined;
      const files = fs.readdirSync(ideDir);
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        try {
          const content = fs.readFileSync(path.join(ideDir, file), 'utf-8');
          const data = JSON.parse(content) as { pid?: number; ideName?: string };
          if (data.pid === pid && data.ideName) {
            return data.ideName;
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
