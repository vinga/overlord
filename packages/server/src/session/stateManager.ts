import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { Session, Room, OfficeSnapshot, WorkerState } from '../types.js';
import { getBridgePath } from '../pty/pipeInjector.js';
import { GitWatcher } from '../git/gitWatcher.js';
import { PrCache } from '../git/prCache.js';
import { readGitStatus } from '../git/gitStatus.js';
import { derivePipeNameFromMarker } from '../bridge/bridgeNameUtils.js';
import { readRoomConfig } from './roomConfig.js';
import { sessionStore } from './sessionStore.js';
import { globalSettingsStore } from './globalSettingsStore.js';
import { log } from '../logger.js';

const QUERY_WORKER_CWD = path.join(os.homedir(), '.claude', 'overlord', 'query-worker');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

function sweepOrphanQueryWorkerFiles(): void {
  try {
    if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) return;
    for (const file of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(CLAUDE_SESSIONS_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { cwd?: string };
        if (data.cwd && path.normalize(data.cwd) === path.normalize(QUERY_WORKER_CWD)) {
          fs.unlinkSync(filePath);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* ignore */ }
}

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
  clearSessionCaches,
} from './transcriptReader.js';
import type { RawSession } from './sessionWatcher.js';
import { saveCompletionHint, loadCompletionHint, clearCompletionHint, saveAck, loadAck } from '../ai/taskStorage.js';
import { planStore } from '../plans/planStore.js';
import type { PlanStatus } from '../plans/types.js';

function planStatusFromClaude(status: 'approved' | 'rejected' | 'pending'): PlanStatus {
  if (status === 'approved') return 'active';
  if (status === 'rejected') return 'archived';
  return 'draft';
}

function derivePlanTitle(plan: string): string {
  const firstLine = plan.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? 'Plan';
  const stripped = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '');
  return stripped.length > 80 ? stripped.slice(0, 77) + '…' : stripped;
}

/** Shallow array equality — avoids JSON.stringify which allocates large temp strings on every 3s poll. */
function shallowArrayEquals(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizePath(p: string): string {
  // Convert WSL path /mnt/c/... to c:/...
  const wslMatch = p.match(/^\/mnt\/([a-z])\/(.*)/i);
  if (wslMatch) return `${wslMatch[1]}:/${wslMatch[2]}`.toLowerCase();
  // Normalize backslashes and lowercase
  return p.replace(/\\/g, '/').toLowerCase();
}

function resolveTranscriptPath(session: {
  cwd: string;
  sessionId: string;
  resumedFrom?: string;
  transcriptPath?: string;
}): string | null {
  if (session.transcriptPath && fs.existsSync(session.transcriptPath)) {
    return session.transcriptPath;
  }
  let transcriptPath = findTranscriptPath(session.cwd, session.sessionId) ?? findTranscriptPathAnywhere(session.sessionId);
  if (!transcriptPath && session.resumedFrom) {
    transcriptPath = findTranscriptPath(session.cwd, session.resumedFrom) ?? findTranscriptPathAnywhere(session.resumedFrom);
  }
  return transcriptPath;
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();
  private onChangeCallback: () => void;
  private onChangePending = false;
  private broadcastSuppressed = false;
  private pendingResumes = new Map<string, { resumeSessionId: string; timestamp: number }>();
  private pendingPtySpawns: Map<string, number> = new Map(); // cwd → timestamp
  /**
   * ptyIds spawned as FRESH sessions (terminal:start, not terminal:resume),
   * mapped to insertion timestamp for TTL cleanup. Used by addOrUpdate to
   * skip the cwd-keyed pendingResumes lookup and prevent stale resume state
   * from contaminating an unrelated fresh spawn. Entries are not consumed
   * on lookup because a single PTY may trigger multiple addOrUpdate calls
   * (initial add + subsequent changed events).
   */
  private freshPtySpawns = new Map<string, number>();
  private static readonly FRESH_PTY_TTL_MS = 5 * 60 * 1000;
  private acceptedSessions: Set<string> = new Set();
  private readonly acceptedFile = path.join(os.homedir(), '.claude', 'overlord-accepted.json');
  private readonly pendingResumesFile = path.join(os.homedir(), '.claude', 'overlord', 'pending-resumes.json');
  private deletedSessionIds: Set<string> = new Set();
  private readonly deletedFile = path.join(os.homedir(), '.claude', 'overlord', 'deleted-sessions.json');
  private knownSessionsFile: string;
  private static readonly IDE_NAME_CACHE_CAP = 64;
  private ideNameCache = new Map<string, { mtimeMs: number; result: { name: string; idePid: number } | undefined }>();
  /** Full process snapshot for fast chain walks — populated on startup, refreshed lazily. */
  private processSnapshot = new Map<number, { parentPid: number; name: string }>();
  private processSnapshotAge = 0;
  /** Sessions awaiting /clear replacement — transcript refresh is suppressed until replaced. */
  private pendingClearSessions = new Set<string>();
  getPendingClearSessions(): string[] { return [...this.pendingClearSessions]; }
  private colorOverrides = new Map<string, string>(); // ovrId → color (persisted to data/colors.json)
  private readonly colorsFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/colors.json');
  /** Sessions that had /clear injected via UI — maps cwd → { sessionId, timestamp } for the next new transcript. */
  private pendingClearReplacements = new Map<string, { sessionId: string; timestamp: number }>();
  /** Timestamp of last PTY output per session — used to override stale 'waiting' state. */
  private lastPtyActivityAt = new Map<string, number>();
  /** Suppress 'waiting' → 'working' promotion until this timestamp. Used after cycle-permission-mode
   *  injection so the TUI status-bar redraw doesn't briefly flip the chip to WORKING. */
  private suppressPromoteUntil = new Map<string, number>();
  /** Bridge sessions forced to 'working' state — persists until explicitly cleared. */
  private bridgeActiveOverride = new Set<string>();
  /** Timestamp when pending PTY input started (user typing without Enter) — cleared on Enter. */
  private ptyInputPendingSince = new Map<string, number>();
  /** Stable ovrId → current active claudeSessionId. Updated by transferSessionState. */
  private sessionsByOvrId = new Map<string, string>();
  readonly bridgePath: string;
  private gitWatcher: GitWatcher;
  private prCache: PrCache;
  private gitAheadCache = new Map<string, { ahead: number; cachedAt: number }>();
  private gitAheadTimer: ReturnType<typeof setInterval> | null = null;

  private generateOvrId(): string {
    return 'ovr-' + Math.random().toString(36).slice(2, 10);
  }

  /** Return the active session for a given overlordId. */
  getActiveClaudeByOvr(ovrId: string): Session | undefined {
    const claudeId = this.sessionsByOvrId.get(ovrId);
    return claudeId ? this.sessions.get(claudeId) : undefined;
  }

  constructor(onChange: () => void) {
    this.bridgePath = getBridgePath();
    this.onChangeCallback = onChange;
    this.knownSessionsFile = path.join(os.homedir(), '.claude', 'overlord', 'known-sessions.json');
    this.gitWatcher = new GitWatcher(() => this.onChange());
    this.prCache = new PrCache(() => this.onChange());
    this.gitAheadTimer = setInterval(() => this.refreshGitAheadCache(), 15_000);
    this.loadAccepted();
    this.loadDeleted();
    this.loadColors();
    this.refreshProcessSnapshot(); // one OS call, populates parentPidCache for all processes
    this.loadKnownSessions();
    this.loadPendingResumes();
    void this.refreshGitAheadCache();
  }

  /** Refresh the full process snapshot (one OS call). */
  private refreshProcessSnapshot(): void {
    this.processSnapshot = getAllProcessInfo();
    this.processSnapshotAge = Date.now();
  }

  private async refreshGitAheadCache(): Promise<void> {
    const cwds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.cwd) cwds.add(session.cwd);
    }
    for (const cwd of cwds) {
      try {
        const status = await readGitStatus(cwd, this.prCache);
        if (status) {
          this.gitAheadCache.set(cwd, { ahead: status.ahead, cachedAt: Date.now() });
        }
      } catch {
        // ignore — stale cache entry stays
      }
    }
  }

  private onChange(): void {
    if (this.onChangePending) return;
    this.onChangePending = true;
    setImmediate(() => {
      this.onChangePending = false;
      if (this.broadcastSuppressed) return;
      this.onChangeCallback();
    });
  }

  /** Suppress snapshot broadcasts. Call resumeBroadcast() when done to fire one consolidated snapshot. */
  suppressBroadcast(): void {
    this.broadcastSuppressed = true;
  }

  resumeBroadcast(): void {
    this.broadcastSuppressed = false;
    this.onChange();
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
      let migratedNames = 0;
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
        const storedOvrId = (entry.overlordId as string | undefined) ?? this.generateOvrId();
        this.sessionsByOvrId.set(storedOvrId, entry.sessionId);
        const color = this.sessionColorByOvrId(storedOvrId);
        // sessionStore is the authoritative source for proposedName. However,
        // legacy code paths (clone-info, /clear transfer, transcript updates)
        // historically mutated session.proposedName in memory without patching
        // sessionStore, so known-sessions.json may hold a fresher value. Boot-
        // time reconciliation: if known-sessions has a non-empty proposedName
        // that differs from sessionStore's value, known-sessions wins (it
        // reflects last-saved in-memory state). After the drift sites are
        // closed (see S6), subsequent boots find no drift.
        const storedRec = sessionStore.getBySessionId(entry.sessionId);
        const entryName = typeof entry.proposedName === 'string' ? entry.proposedName : undefined;
        let resolvedProposedName = storedRec?.proposedName ?? entryName;
        if (entryName && entryName !== storedRec?.proposedName) {
          sessionStore.patch(storedOvrId, { proposedName: entryName });
          resolvedProposedName = entryName;
          migratedNames += 1;
        }
        const storedHistory = (entry.sessionHistory as Array<{ sessionId: string; attachedAt: number }> | undefined)
          ?? [{ sessionId: entry.sessionId, attachedAt: entry.startedAt ?? Date.now() }];
        this.sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          overlordId: storedOvrId,
          sessionHistory: storedHistory,
          provider: entry.provider ?? 'claude',
          providerSessionId: (entry.providerSessionId as string | undefined) ?? storedRec?.providerSessionId,
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
          proposedName: resolvedProposedName,
          resumedFrom: entry.resumedFrom,
          userAccepted: entry.userAccepted,
          bridgePipeName: entry.bridgePipeName,
          bridgeMarker: entry.bridgeMarker,
          transcriptPath: entry.transcriptPath,
          acknowledged: loadAck(entry.sessionId),
          gitBranch: storedRec?.gitBranch,
        });

        // Load transcript for closed sessions so conversation history is visible after restart
        const transcriptPath = resolveTranscriptPath({
          cwd: entry.cwd,
          sessionId: entry.sessionId,
          resumedFrom: entry.resumedFrom,
          transcriptPath: entry.transcriptPath,
        });
        if (transcriptPath) {
          try {
            const result = readTranscriptState(transcriptPath);
            const s = this.sessions.get(entry.sessionId)!;
            s.activityFeed = result.activityFeed;
            if (result.lastActivity) s.lastActivity = result.lastActivity;
            s.lastMessage = result.lastMessage;
            s.model = result.model;
            s.inputTokens = result.inputTokens;
            s.compactCount = result.compactCount;
            // Do NOT override state — keep it 'closed'
          } catch { /* ignore */ }
        }
      }
      if (dirty) {
        fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
        fs.writeFileSync(this.knownSessionsFile, JSON.stringify(cleaned, null, 2));
      }
      if (migratedNames > 0) {
        console.log(`[migration] reconciled ${migratedNames} proposedName entries into sessionStore`);
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

  saveKnownSessions(): void {
    try {
      fs.mkdirSync(path.dirname(this.knownSessionsFile), { recursive: true });
      const entries = [...this.sessions.values()]
        .filter(s => !s.isWorker && !s.cwd.toLowerCase().replace(/\\/g, '/').includes('/.claude/'))
        .map(s => ({
          sessionId: s.sessionId,
          overlordId: s.overlordId,
          sessionHistory: s.sessionHistory,
          provider: s.provider,
          providerSessionId: s.providerSessionId,
          cwd: s.cwd,
          sessionType: s.sessionType,
          replacedBy: s.replacedBy,
          startedAt: s.startedAt,
          pid: s.pid,
          // proposedName intentionally omitted — sessionStore (OverlordSession) is the durable source.
          resumedFrom: s.resumedFrom,
          userAccepted: s.userAccepted,
          bridgePipeName: s.bridgePipeName,
          bridgeMarker: s.bridgeMarker,
          transcriptPath: s.transcriptPath,
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
    const deletedSession = this.sessions.get(sessionId);
    clearSessionCaches(sessionId, deletedSession?.transcriptPath, deletedSession?.cwd);
    const deletedOvrId = deletedSession?.overlordId;
    if (deletedOvrId) {
      this.colorOverrides.delete(deletedOvrId);
      this.saveColors();
    }
    this.sessions.delete(sessionId);
    this.saveKnownSessions();
    this.onChange();
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

  trackPendingPtySpawn(cwd: string, ptySessionId?: string): void {
    const now = Date.now();
    this.pendingPtySpawns.set(normalizePath(cwd), now);
    if (ptySessionId) {
      this.freshPtySpawns.set(ptySessionId, now);
      // Evict expired fresh markers opportunistically so the map does not grow.
      for (const [key, ts] of this.freshPtySpawns) {
        if (now - ts > StateManager.FRESH_PTY_TTL_MS) this.freshPtySpawns.delete(key);
      }
      // A fresh spawn in this cwd invalidates any stale pendingResume
      // that was never consumed — it can no longer belong to this PTY.
      if (this.pendingResumes.has(normalizePath(cwd))) {
        this.pendingResumes.delete(normalizePath(cwd));
        this.savePendingResumes();
      }
    }
  }

  addOrUpdate(raw: RawSession): { isNewWaiting: boolean; lastMessage?: string } {
    const { pid, sessionId, cwd, startedAt } = raw;

    // Skip sessions that were explicitly deleted by the user
    if (this.deletedSessionIds.has(sessionId)) {
      return { isNewWaiting: false };
    }

    const existingSession = this.sessions.get(sessionId);

    // Guard against "session stealing": when two PTYs `--resume` the same
    // parent sessionId concurrently, the second PTY's {pid}.json transiently
    // reports the parent sid with a different pid/startedAt. Without a guard
    // the existing entry's pid would be overwritten, later causing
    // findSessionByPid to false-match and transferSessionState to steal the
    // ovrId.
    //
    // We only block when the existing session is STILL LIVE (not closed) —
    // a closed session being resumed is legitimate: the new PTY replaces
    // the dead process and keeps the lineage. Willow/Isolde are both live
    // and hit this block; a user clicking "Resume" on a closed session does
    // not.
    if (
      existingSession &&
      existingSession.state !== 'closed' &&
      existingSession.pid > 0 &&
      pid > 0 &&
      existingSession.pid !== pid &&
      existingSession.startedAt !== startedAt
    ) {
      console.log(
        `[stateManager] rejecting conflicting update for ${sessionId.slice(0, 8)}: ` +
        `existing pid=${existingSession.pid} startedAt=${existingSession.startedAt} (live), ` +
        `incoming pid=${pid} startedAt=${startedAt} — likely concurrent --resume`
      );
      return { isNewWaiting: false };
    }

    // Extract the ptyId marker from raw.name (format: `[name]___OVR:<ptyId>`).
    // Used to distinguish fresh PTY spawns from resumes so the cwd-keyed
    // pendingResumes lookup below doesn't contaminate a fresh session with a
    // stale resume entry from the same cwd. The marker is NOT consumed —
    // a single PTY can trigger multiple addOrUpdate calls (initial add plus
    // subsequent changed events) and all of them must see the flag.
    const markerMatch = raw.name?.includes('___OVR:') ? raw.name.split('___OVR:')[1] : undefined;
    const isFreshSpawn = markerMatch !== undefined && this.freshPtySpawns.has(markerMatch);

    // Check for a pending resume: if this session was just resumed from another, link them.
    // Resolved early so the transcript fallback below can use it.
    let resumedFrom: string | undefined;
    if (existingSession?.resumedFrom) {
      resumedFrom = existingSession.resumedFrom;
    } else if (!isFreshSpawn) {
      const pendingEntry = this.pendingResumes.get(normalizePath(cwd));
      if (pendingEntry && Date.now() - pendingEntry.timestamp < 60000) {
        resumedFrom = pendingEntry.resumeSessionId;
        this.pendingResumes.delete(normalizePath(cwd));
        this.savePendingResumes();
      }
    }
    // Guard against self-loop: when `--resume X` keeps the same sessionId
    // (Claude takes over the parent sid), the pending resume target equals
    // the incoming sid. Leaving resumedFrom === sessionId breaks transcript
    // fallback resolution and persists a broken record to known-sessions.
    if (resumedFrom === sessionId) resumedFrom = undefined;

    // Read transcript — own first, then fall back to resumed-from (for --resume which appends to parent)
    const transcriptPath = raw.transcriptPath ?? resolveTranscriptPath({
      cwd,
      sessionId,
      resumedFrom,
      transcriptPath: existingSession?.transcriptPath,
    });

    const transcript = transcriptPath ? readTranscriptState(transcriptPath) : undefined;
    const slug = transcriptPath ? readSlug(transcriptPath) : undefined;

    const transcriptState = transcript?.state ?? existingSession?.state ?? 'waiting';
    // If transcript says 'waiting' but PTY was active within the last 5s, the session is still
    // working — transcript just hasn't been updated yet (e.g. between tool calls).
    // Only apply this override when a transcript exists; new sessions with no transcript
    // should start as 'waiting' even though the PTY emits an initial prompt.
    const lastPtyAt = this.lastPtyActivityAt.get(sessionId);
    const ptyIsRecent = lastPtyAt != null && Date.now() - lastPtyAt < 5000;
    const bridgeActive = this.bridgeActiveOverride.has(sessionId);
    // Also require the transcript to have at least one activity item — a brand-new
    // session (transcript file exists but empty) should stay 'waiting' even though
    // the bridge/PTY emits output during Claude Code's own startup screen.
    const hasMessages = transcript?.activityFeed !== undefined;
    const state: WorkerState = (transcriptState === 'waiting' && (ptyIsRecent || bridgeActive) && transcript !== undefined && hasMessages) ? 'working' : transcriptState;
    const lastActivity = transcript?.lastActivity ?? new Date().toISOString();
    let rawName = raw.name?.includes('___OVR:') ? raw.name.split('___OVR:')[0] : raw.name;
    // Also strip bridge marker (___BRG:xxx) from display name
    if (rawName?.includes('___BRG:')) rawName = rawName.split('___BRG:')[0];
    // Prefer the in-memory name on existing sessions — it reflects user renames
    // (written to sessionStore and into live.proposedName). `rawName` from
    // {pid}.json is set at spawn time and never updated, so using it as the
    // primary source would overwrite renames on every sessionWatcher tick.
    const existingName = existingSession?.proposedName?.startsWith('<local-command-caveat')
      ? undefined
      : existingSession?.proposedName;
    const resolvedName = existingName
      ?? (rawName || undefined)
      ?? (transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined)
      ?? (resumedFrom ? this.sessions.get(resumedFrom)?.proposedName : undefined);
    // Strip <local-command-caveat> prefix — treat it as no name so transferName can override
    const proposedName = resolvedName?.startsWith('<local-command-caveat') ? undefined : resolvedName;

    const subagents = readSubagents(cwd, sessionId, transcriptPath);
    // Color resolution deferred until after overlordId is computed below
    let color = this.sessionColor(sessionId);
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

    // Preserve overlordId across updates; generate once on first creation.
    // On resume, inherit the parent's ovrId so the new sessionId attaches to the
    // existing lineage rather than minting a duplicate OverlordSession record.
    const overlordId = existingSession?.overlordId
      ?? (resumedFrom
        ? (sessionStore.resolveOverlordId(resumedFrom) ?? this.sessions.get(resumedFrom)?.overlordId)
        : undefined)
      ?? this.generateOvrId();
    color = this.sessionColorByOvrId(overlordId);
    // Preserve sessionHistory; initialize with first entry on creation.
    const sessionHistory: Array<{ sessionId: string; attachedAt: number }> =
      existingSession?.sessionHistory ?? [{ sessionId, attachedAt: Date.now() }];

    const session: Session = {
      sessionId,
      overlordId,
      sessionHistory,
      provider: raw.provider ?? existingSession?.provider ?? 'claude',
      providerSessionId: existingSession?.providerSessionId,
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
      needsPermission: (() => {
        // When the screen-detected mode is locked, it represents ground truth from the
        // live TUI — prefer it over the transcript value (which lags by one user message).
        const lockActive = existingSession?.permissionModeLockedUntil != null
          && Date.now() < existingSession.permissionModeLockedUntil;
        const effectivePermMode = lockActive
          ? (existingSession?.permissionMode ?? transcript?.permissionMode)
          : (transcript?.permissionMode || existingSession?.permissionMode);
        if (effectivePermMode === 'bypassPermissions') return undefined;
        return transcript?.needsPermission || existingSession?.needsPermission;
      })(),
      permissionPromptText: transcript?.permissionPromptText || existingSession?.permissionPromptText,
      isLimitPrompt: existingSession?.isLimitPrompt,
      permissionMode: (() => {
        // If a shift+tab / cycle-endpoint detection has locked the mode, honor the lock.
        // Otherwise fall back to transcript (fresh session) or prior in-memory value.
        const lockActive = existingSession?.permissionModeLockedUntil != null
          && Date.now() < existingSession.permissionModeLockedUntil;
        if (lockActive) return existingSession?.permissionMode ?? transcript?.permissionMode;
        return transcript?.permissionMode || existingSession?.permissionMode;
      })(),
      permissionModeLockedUntil: existingSession?.permissionModeLockedUntil,
      permissionApprovedAt: existingSession?.permissionApprovedAt,
      pendingQuestion: transcript?.pendingQuestion ?? existingSession?.pendingQuestion,
      activeMonitors: transcript?.activeMonitors,
      completionHint: state === 'waiting' ? (existingSession?.completionHint ?? (isNew ? loadCompletionHint(sessionId) : undefined)) : undefined,
      acknowledged: state === 'waiting' ? (existingSession?.acknowledged ?? (isNew ? loadAck(sessionId) : false)) : false,
      userAccepted: this.acceptedSessions.has(sessionId) || existingSession?.userAccepted,
      isWorker: raw.kind === 'haiku-worker',
      bridgePipeName: existingSession?.bridgePipeName,
      bridgeMarker: existingSession?.bridgeMarker,
      ptySessionId: existingSession?.ptySessionId,
      transcriptPath: transcriptPath ?? undefined,
      ptyInputPendingSince: this.ptyInputPendingSince.get(sessionId),
    };

    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(overlordId, sessionId);
    sessionStore.ensureFromLive(session);

    // When a resume inherits the parent's ovrId, mark the parent session as replaced
    // so it no longer appears as an active / stale entry in the UI (mirrors /clear behaviour).
    if (isNew && resumedFrom && resumedFrom !== sessionId) {
      const parentSession = this.sessions.get(resumedFrom);
      if (parentSession && parentSession.overlordId === overlordId && !parentSession.replacedBy) {
        parentSession.replacedBy = sessionId;
      }
    }

    // Persist plans via planStore — dedupes on claudePlanToolUseId so repeated
    // readTranscriptState calls are idempotent.
    if (transcript?.detectedPlans && transcript.detectedPlans.length > 0) {
      for (const p of transcript.detectedPlans) {
        planStore.upsertFromClaude({
          overlordId,
          cwd,
          claudePlanToolUseId: p.planToolUseId,
          body: p.plan,
          status: planStatusFromClaude(p.planStatus),
          title: derivePlanTitle(p.plan),
        });
      }
    }

    if (isNew) {
      this.saveKnownSessions();
    }
    this.onChange();
    return { isNewWaiting: isNew && state === 'waiting', lastMessage: transcript?.lastMessage };
  }

  remove(sessionId: string): void {
    this.pendingClearSessions.delete(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const ovrId = existing.overlordId;
      // Only remove from sessionsByOvrId if this session is still the active one for this ovrId
      if (ovrId && this.sessionsByOvrId.get(ovrId) === sessionId) {
        this.sessionsByOvrId.delete(ovrId);
      }
      this.sessions.delete(sessionId);
      clearSessionCaches(sessionId, existing.transcriptPath, existing.cwd);
      this.saveKnownSessions();
      this.onChange();
    }
  }

  /**
   * Register a raw-shell session (no Claude, no transcript). Uses a synthetic
   * sessionId that also serves as ovrId and ptySessionId. The session is never
   * persisted — it exists only in memory until the PTY exits.
   */
  addRawSession(sessionId: string, cwd: string, pid: number, proposedName?: string): Session {
    const session: Session = {
      sessionId,
      overlordId: sessionId,
      sessionHistory: [{ sessionId, attachedAt: Date.now() }],
      provider: undefined,
      providerSessionId: undefined,
      proposedName,
      pid,
      startedAt: Date.now(),
      cwd,
      state: 'working',
      lastActivity: new Date().toISOString(),
      sessionType: 'raw',
      color: this.sessionColorByOvrId(sessionId),
      subagents: [],
      ptySessionId: sessionId,
    };
    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(sessionId, sessionId);
    sessionStore.ensureFromLive(session);
    this.onChange();
    return session;
  }

  /**
   * Revive a raw-shell session from disk history (no live PTY). The worker will
   * show up in the office as closed/dormant with a "Restart shell" action.
   */
  addHistoryOnlyRawSession(sessionId: string, cwd: string, proposedName: string | undefined, lastActivity: number): Session {
    const session: Session = {
      sessionId,
      overlordId: sessionId,
      sessionHistory: [{ sessionId, attachedAt: lastActivity }],
      provider: undefined,
      providerSessionId: undefined,
      proposedName,
      pid: 0,
      startedAt: lastActivity,
      cwd,
      state: 'closed',
      lastActivity: new Date(lastActivity).toISOString(),
      sessionType: 'raw',
      color: this.sessionColorByOvrId(sessionId),
      subagents: [],
      ptySessionId: sessionId,
      historyOnly: true,
    };
    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(sessionId, sessionId);
    sessionStore.ensureFromLive(session);
    this.onChange();
    return session;
  }

  addManagedProviderSession(
    sessionId: string,
    cwd: string,
    pid: number,
    provider: 'opencode',
    proposedName?: string,
    providerSessionId?: string,
  ): Session {
    const session: Session = {
      sessionId,
      overlordId: sessionId,
      sessionHistory: [{ sessionId, attachedAt: Date.now() }],
      provider,
      providerSessionId,
      proposedName,
      pid,
      startedAt: Date.now(),
      cwd,
      state: 'working',
      lastActivity: new Date().toISOString(),
      sessionType: 'embedded',
      color: this.sessionColorByOvrId(sessionId),
      subagents: [],
      ptySessionId: sessionId,
    };
    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(sessionId, sessionId);
    sessionStore.ensureFromLive(session);
    this.saveKnownSessions();
    this.onChange();
    return session;
  }

  reviveManagedProviderSession(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pid = pid;
    session.state = 'working';
    session.lastActivity = new Date().toISOString();
    session.loadedAt = Date.now();
    this.saveKnownSessions();
    this.onChange();
  }

  clearHistoryOnly(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.historyOnly) {
      this.sessions.set(sessionId, { ...session, historyOnly: false });
      this.onChange();
    }
  }

  reviveRawToWorking(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, {
      ...session,
      historyOnly: false,
      state: 'working',
      pid,
      startedAt: Date.now(),
      lastActivity: new Date().toISOString(),
    });
    this.onChange();
  }

  setHistoryOnly(sessionId: string, value: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session && !!session.historyOnly !== value) {
      this.sessions.set(sessionId, { ...session, historyOnly: value });
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
      if (newSession.overlordId) {
        sessionStore.patch(newSession.overlordId, { proposedName: oldSession.proposedName });
      }
    }
    // Color is keyed by ovrId and inherited via overlordId below — no transfer needed here.
    // Just refresh the baked color field on the session object in case an override exists.
    newSession.color = this.sessionColorByOvrId(newSession.overlordId || oldSession.overlordId);
    // Preserve position in sort order — inherit old session's startedAt so server-side
    // sort (by startedAt) keeps the cleared session at the same index it occupied before.
    newSession.startedAt = oldSession.startedAt;
    // Transfer bridge/PTY connection metadata
    if (oldSession.bridgePipeName) newSession.bridgePipeName = oldSession.bridgePipeName;
    if (oldSession.bridgeMarker) newSession.bridgeMarker = oldSession.bridgeMarker;
    if (oldSession.bridgeTty) newSession.bridgeTty = oldSession.bridgeTty;
    if (oldSession.ptySessionId) newSession.ptySessionId = oldSession.ptySessionId;
    if (oldSession.sessionType !== 'plain') newSession.sessionType = oldSession.sessionType;
    // Inherit stable overlordId — this is the core of the ovrId design.
    // The new session takes over the old session's lineage identity so PTY routing
    // (keyed by ovrId) does not need to change.
    // If newSession already has an overlordId (e.g. it was loaded from known-sessions at startup),
    // keep it — don't clobber an established PTY link with an interim session's generated ovrId.
    const inheritedOvrId = newSession.overlordId || oldSession.overlordId;
    newSession.overlordId = inheritedOvrId;
    // Inherit session history: merge old + new, deduplicating by sessionId.
    // If newSession already has history (it was a real session, not an interim), union them.
    const oldHistory = oldSession.sessionHistory ?? [{ sessionId: oldSessionId, attachedAt: oldSession.startedAt }];
    const newHistory = newSession.sessionHistory ?? [{ sessionId: newSessionId, attachedAt: newSession.startedAt }];
    const seen = new Set<string>();
    newSession.sessionHistory = [...oldHistory, ...newHistory]
      .filter(e => { if (seen.has(e.sessionId)) return false; seen.add(e.sessionId); return true; })
      .sort((a, b) => a.attachedAt - b.attachedAt);
    this.sessionsByOvrId.set(inheritedOvrId, newSessionId);
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

  /**
   * Detect a sid-revert pattern: sessionHistory already contains `candidateSid`
   * at an earlier position than the current active sid for this ovrId. Returns
   * true when a raw 'changed' event with `candidateSid` should be treated as a
   * revert (e.g., post-compaction rebind to original transcript) rather than a
   * forward /clear. Caller must additionally check pid + startedAt.
   */
  isRevertCandidate(ovrId: string, candidateSid: string): boolean {
    const activeSid = this.sessionsByOvrId.get(ovrId);
    if (!activeSid || activeSid === candidateSid) return false;
    if (this.deletedSessionIds.has(candidateSid)) return false;
    const active = this.sessions.get(activeSid);
    const history = active?.sessionHistory;
    if (!history || history.length < 2) return false;
    const activeEntry = history.find(e => e.sessionId === activeSid);
    const candidateEntry = history.find(e => e.sessionId === candidateSid);
    if (!activeEntry || !candidateEntry) return false;
    return candidateEntry.attachedAt < activeEntry.attachedAt;
  }

  /**
   * Revert the ovrId pointer back to an earlier sid in its history. Used when
   * Claude auto-compaction (or similar) rebinds the session file to the
   * original transcript after a /clear. Transfers live connection metadata
   * forward from the interim session, clears replacedBy on the target, and
   * removes the interim entry from the map (but keeps it in sessionHistory).
   */
  revertToSid(interimSessionId: string, targetSessionId: string): void {
    const interim = this.sessions.get(interimSessionId);
    const target = this.sessions.get(targetSessionId);
    if (!interim || !target) {
      log('sid:revert', 'Revert skipped — missing session', { sessionId: targetSessionId, sessionName: target?.proposedName ?? targetSessionId.slice(0, 8), extra: `interim=${interimSessionId.slice(0, 8)} target=${targetSessionId.slice(0, 8)} interimFound=${!!interim} targetFound=${!!target}` });
      return;
    }
    const ovrId = interim.overlordId;
    if (!ovrId) return;

    // Transfer live connection metadata forward: whatever was on interim
    // is the most recent truth (bridge pipe handle, PTY link, tty).
    if (interim.bridgePipeName) target.bridgePipeName = interim.bridgePipeName;
    if (interim.bridgeMarker) target.bridgeMarker = interim.bridgeMarker;
    if (interim.bridgeTty) target.bridgeTty = interim.bridgeTty;
    if (interim.ptySessionId) target.ptySessionId = interim.ptySessionId;
    if (interim.sessionType !== 'plain') target.sessionType = interim.sessionType;

    // Promote target back to active: clear replacedBy, inherit liveness state.
    target.replacedBy = undefined;
    target.overlordId = ovrId;
    target.state = interim.state;
    target.pid = interim.pid;
    // Keep target.startedAt as-is (original spawn time). Do NOT overwrite with
    // interim.startedAt — we want chronological integrity preserved.
    // Do NOT touch target.resumedFrom — leave it as whatever it was before
    // the interim session was born (typically undefined for the original).
    // Do NOT touch target.sessionHistory — the merged history from the forward
    // transferSessionState is correct; we just point back at an earlier entry.

    this.sessionsByOvrId.set(ovrId, targetSessionId);

    // Remove interim from the live session map. It remains referenced in
    // sessionHistory as a past attachment.
    this.sessions.delete(interimSessionId);
    clearSessionCaches(interimSessionId, interim.transcriptPath, interim.cwd);

    log('sid:revert', 'Reverted ovrId to prior sid', { sessionId: targetSessionId, sessionName: target.proposedName ?? targetSessionId.slice(0, 8), extra: `ovrId=${ovrId} interim=${interimSessionId.slice(0, 8)} target=${targetSessionId.slice(0, 8)}` });
    this.saveKnownSessions();
    this.onChange();
  }

  setBridgeTty(sessionId: string, tty: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridgeTty = tty;
    this.onChange();
  }

  setBridgePipe(sessionId: string, pipeName: string, marker?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridgePipeName = pipeName;
    if (marker !== undefined) session.bridgeMarker = marker;
    this.saveKnownSessions();
    this.onChange();
  }

  setBridgeDead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.bridgeDead = true;
    log('bridge:dead', 'Bridge pipe permanently lost', { sessionId, sessionName: session.proposedName ?? sessionId.slice(0, 8) });
    this.onChange();
  }

  clearBridgeDead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.bridgeDead) return;
    session.bridgeDead = undefined;
    this.onChange();
  }

  isBridge(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.sessionType === 'bridge';
  }

  /** Find the active (non-deleted, non-closed) bridge session matching the given marker.
   *  Matches either by stored bridgeMarker, or by deriving the pipeName from the marker
   *  and comparing to bridgePipeName (handles legacy sessions that lack bridgeMarker). */
  findActiveBridgeByMarker(marker: string): Session | undefined {
    const derivedPipe = derivePipeNameFromMarker(marker);
    for (const session of this.sessions.values()) {
      if (this.deletedSessionIds.has(session.sessionId)) continue;
      if (session.state === 'closed') continue;
      if (session.sessionType !== 'bridge') continue;
      if (session.bridgeMarker === marker || session.bridgePipeName === derivedPipe) {
        return session;
      }
    }
    return undefined;
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
      this.saveKnownSessions();
      this.onChange();
    }
  }

  setProviderSessionId(sessionId: string, providerSessionId: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.providerSessionId === providerSessionId) return;
    session.providerSessionId = providerSessionId;
    if (session.overlordId) {
      sessionStore.patch(session.overlordId, { providerSessionId });
    }
    this.saveKnownSessions();
    this.onChange();
  }

  refreshTranscript(sessionId: string): { becameWaiting: boolean; lastMessage?: string; becameWorking: boolean; leftWorking: boolean; transcriptStale: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };
    const transcriptPath = resolveTranscriptPath(session);
    if (!transcriptPath) return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };

    const prevState = session.state;
    const result = readTranscriptState(transcriptPath);

    // Suppress re-read until /clear replacement is detected (prevents old transcript
    // re-populating feed). BUT: if the transcript was truncated in place (same sid,
    // smaller file — typical for /clear inside a --resume'd session), that IS the
    // replacement event. Clear the pending flag and proceed normally.
    if (this.pendingClearSessions.has(sessionId)) {
      if (result.transcriptTruncated) {
        this.pendingClearSessions.delete(sessionId);
        // Also consume the pending clear replacement entry so the transcript
        // watcher doesn't later match an unrelated orphan to this session.
        this.consumePendingClearReplacement(session.cwd);
      } else {
        return { becameWaiting: false, becameWorking: false, leftWorking: false, transcriptStale: false };
      }
    }
    const subagents = readSubagents(session.cwd, sessionId, transcriptPath);
    const slug = session.slug ?? readSlug(transcriptPath);
    const proposedName = session.proposedName ?? readProposedName(sessionId, transcriptPath);

    // In-place /clear detection: the transcript file was rewritten smaller on
    // disk, which for append-only jsonl means the session reset its context.
    // This happens when /clear runs inside a `--resume`'d session because
    // Claude Code keeps the same sessionId and truncates the existing file
    // instead of creating a new one — so none of the sid-change based /clear
    // paths (sessionEventHandlers 'changed', stale-transcript poll, pending-
    // clear orphan) ever fire. Drop stale pre-clear state on the same session.
    if (result.transcriptTruncated) {
      session.activityFeed = undefined;
      session.lastMessage = undefined;
      session.ptyCompactItems = undefined;
      session.ptyCompactBaseline = undefined;
      session.ptyCompactBaselineAt = undefined;
      session.ptyCompactBoundarySeen = undefined;
      session.compactCount = undefined;
      session.isCompacting = undefined;
      session.needsPermission = undefined;
      session.permissionPromptText = undefined;
      session.isLimitPrompt = undefined;
      session.completionHint = undefined;
      session.completionHintByUser = false;
      clearCompletionHint(sessionId);
      session.acknowledged = false;
      saveAck(sessionId, false);
      log('clear:detected', 'In-place transcript truncation', {
        sessionId,
        sessionName: session.proposedName ?? sessionId.slice(0, 8),
      });
    }

    let changed =
      session.state !== result.state ||
      session.lastActivity !== result.lastActivity ||
      session.lastMessage !== result.lastMessage ||
      !shallowArrayEquals(session.activityFeed, result.activityFeed) ||
      session.model !== result.model ||
      session.inputTokens !== result.inputTokens ||
      session.compactCount !== result.compactCount ||
      session.isCompacting !== result.isCompacting ||
      session.needsPermission !== result.needsPermission ||
      session.slug !== slug ||
      session.proposedName !== proposedName ||
      !shallowArrayEquals(session.subagents, subagents);

    if (changed) {
      // Clear completionHint when leaving waiting state
      if (prevState === 'waiting' && result.state !== 'waiting') {
        session.completionHint = undefined;
        session.completionHintByUser = false;
        clearCompletionHint(sessionId);
        session.userAccepted = undefined;
        this.acceptedSessions.delete(sessionId);
        if (session.acknowledged) {
          session.acknowledged = false;
          saveAck(sessionId, false);
        }
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
      // Merge PTY-sourced compact items into the transcript feed.
      // PTY items carry timing info ("2m 1s · ↑ 698 tokens") that compact_boundary lacks.
      // Keep a PTY item if no transcript compact item is within 60 seconds of it.
      let mergedFeed = result.activityFeed ?? [];
      if (session.ptyCompactItems && session.ptyCompactItems.length > 0) {
        const transcriptCompactTimes = mergedFeed
          .filter(i => i.kind === 'compact' && i.timestamp)
          .map(i => new Date(i.timestamp!).getTime());
        const orphanPtyItems = session.ptyCompactItems.filter(ptyItem => {
          if (!ptyItem.timestamp) return true;
          const t = new Date(ptyItem.timestamp).getTime();
          return !transcriptCompactTimes.some(tc => Math.abs(tc - t) < 60_000);
        });
        if (orphanPtyItems.length > 0) {
          // Insert PTY compact items in chronological position.
          // activityFeed is oldest-first (readTranscriptState uses unshift in backward scan),
          // so ascending-time sort keeps that order.
          mergedFeed = [...mergedFeed, ...orphanPtyItems].sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return ta - tb;
          });
        }
      }
      session.activityFeed = mergedFeed.length > 0 ? mergedFeed : undefined;
      session.feedTruncated = (result as { feedTruncated?: boolean }).feedTruncated;
      session.model = result.model;
      session.inputTokens = result.inputTokens;
      session.compactCount = result.compactCount;
      // Keep isCompacting sticky while PTY has seen "Compacting conversation…"
      // and the transcript hasn't yet recorded a new compact_boundary.
      // Release conditions (handle race where PTY fires after boundary already landed):
      //   1. compactCount advanced past baseline — normal path
      //   2. transcript's own isCompacting was seen true and has since gone false — boundary observed
      //   3. TTL safety: baseline older than 5 minutes — avoid permanent stuck state
      const baseline = session.ptyCompactBaseline;
      if (baseline !== undefined && result.isCompacting) {
        session.ptyCompactBoundarySeen = true;
      }
      const baselineAgeMs = session.ptyCompactBaselineAt ? Date.now() - session.ptyCompactBaselineAt : 0;
      const countAdvanced = baseline !== undefined && (result.compactCount ?? 0) > baseline;
      const boundaryObserved = baseline !== undefined && session.ptyCompactBoundarySeen === true && !result.isCompacting;
      const ttlExpired = baseline !== undefined && baselineAgeMs > 90_000;
      const boundaryLanded = countAdvanced || boundaryObserved || ttlExpired;
      if (boundaryLanded) {
        session.ptyCompactBaseline = undefined;
        session.ptyCompactBaselineAt = undefined;
        session.ptyCompactBoundarySeen = undefined;
      }
      const stickyCompacting = baseline !== undefined && !boundaryLanded;
      session.isCompacting = result.isCompacting || stickyCompacting;
      // Only overwrite permissionMode from transcript if screen hasn't locked it recently
      // and the value actually differs (avoids gratuitous onChange churn).
      if (result.permissionMode
        && result.permissionMode !== session.permissionMode
        && !(session.permissionModeLockedUntil && Date.now() < session.permissionModeLockedUntil)) {
        session.permissionMode = result.permissionMode;
      }
      // Detect rate-limit text in the activity feed (for plain/bridge sessions where
      // permissionChecker can't read the screen). Check last 8 feed items.
      const RATE_LIMIT_RE = /you'?ve hit your (daily )?limit|rate.?limit/i;
      const feedHasRateLimit = result.state === 'waiting' &&
        mergedFeed.slice(0, 8).some(item => item.content && RATE_LIMIT_RE.test(item.content));
      // Only update needsPermission from transcript when it clears (goes false).
      // Setting it true is owned by transcriptReader/addOrUpdate; clearing is also
      // done here when the session advances (transcript no longer shows stale tool_use).
      if (!result.needsPermission && !feedHasRateLimit || session.permissionMode === 'bypassPermissions') {
        session.needsPermission = undefined;
        session.isLimitPrompt = undefined;
        session.permissionPromptText = undefined;
      } else if (!session.needsPermission && feedHasRateLimit) {
        // Rate-limit detected in feed — show PermissionPrompt dialog
        const suppressed = session.permissionApprovedAt &&
          Date.now() - session.permissionApprovedAt < 30_000;
        if (!suppressed) {
          session.needsPermission = true;
          session.isLimitPrompt = true;
          if (!session.permissionPromptText) {
            // Extract rate-limit text from the matching feed item
            const limitItem = mergedFeed.slice(0, 8).find(item =>
              item.content && RATE_LIMIT_RE.test(item.content)
            );
            session.permissionPromptText = limitItem?.content ?? 'Rate limit reached';
          }
        }
      } else if (!session.needsPermission) {
        // Respect the 30s suppression window after user approved
        const suppressed = session.permissionApprovedAt &&
          Date.now() - session.permissionApprovedAt < 30_000;
        const isBypass = session.permissionMode === 'bypassPermissions';
        if (!suppressed && !isBypass) {
          session.needsPermission = result.needsPermission;
          if (result.permissionPromptText && !session.permissionPromptText) {
            session.permissionPromptText = result.permissionPromptText;
          }
        }
      }
      // Update pendingQuestion: set when present, clear when gone
      session.pendingQuestion = result.pendingQuestion ?? undefined;
      session.slug = slug;
      if (session.proposedName !== proposedName) {
        session.proposedName = proposedName;
        if (session.overlordId) {
          sessionStore.patch(session.overlordId, { proposedName });
        }
      }
      session.subagents = subagents;
      session.transcriptPath = transcriptPath;
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

  /** Toggle the acknowledged flag — silences the pulsing WAITING bubble without marking done. */
  toggleAckByUser(sessionId: string): boolean | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed') return null;
    const next = !session.acknowledged;
    session.acknowledged = next;
    saveAck(sessionId, next);
    this.onChange();
    return next;
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
    if (session.acknowledged) {
      session.acknowledged = false;
      saveAck(sessionId, false);
      changed = true;
    }
    // Only promote to 'working' if the session has prior activity — otherwise a
    // brand-new embedded session (which may emit spurious terminal input during
    // startup) would flip to 'working' before the user has actually typed anything.
    if (session.state === 'waiting' && session.activityFeed && session.activityFeed.length > 0) {
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

  setNeedsPermission(sessionId: string, value: boolean, promptText?: string, isLimitPrompt?: boolean): void {
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
        session.isLimitPrompt = isLimitPrompt;
        this.onChange();
      } else if (promptText && promptText !== session.permissionPromptText) {
        // Screen reader text is richer than transcript-derived text — always update
        session.permissionPromptText = promptText;
        session.isLimitPrompt = isLimitPrompt;
        this.onChange();
      }
    } else {
      session.permissionApprovedAt = Date.now();  // start suppression window
      if (session.needsPermission || session.permissionPromptText !== undefined) {
        session.needsPermission = undefined;
        session.permissionPromptText = undefined;
        session.isLimitPrompt = undefined;
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

  /** @deprecated No-op. Request summaries superseded by Task.title. */
  setRequestSummary(_sessionId: string, _summary: string): void { /* no-op */ }

  /** Sets the rolling intent summary for a session and broadcasts the update. */
  setIntent(sessionId: string, intent: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.intent === intent) return;
    session.intent = intent;
    this.onChange();
  }

  setCompacting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.isCompacting) return;
    session.isCompacting = true;
    this.onChange();
  }

  addPtyCompact(sessionIdOrOvr: string, text: string): void {
    // Callers pass either a Claude sessionId or an overlordId — resolve to the active session.
    const session = this.sessions.get(sessionIdOrOvr) ?? this.getActiveClaudeByOvr(sessionIdOrOvr);
    if (!session) return;
    // If the transcript already recorded a compact_boundary within the last 30s,
    // this PTY detection is late — the compact already finished. Drop it entirely
    // so we don't flip isCompacting back on and block sends.
    const now = Date.now();
    const recentTranscriptBoundary = (session.activityFeed ?? []).some(i =>
      i.kind === 'compact' && i.compactMeta && i.timestamp &&
      now - new Date(i.timestamp).getTime() < 30_000
    );
    if (recentTranscriptBoundary) return;
    const item: import('../types.js').ActivityItem = {
      kind: 'compact',
      content: text,
      timestamp: new Date(now).toISOString(),
    };
    if (!session.ptyCompactItems) session.ptyCompactItems = [];
    session.ptyCompactItems.push(item);
    // activityFeed is oldest-first; append to the end so the compact item
    // shows at the newest position in the Conversation Tab.
    if (!session.activityFeed) session.activityFeed = [];
    session.activityFeed.push(item);
    session.isCompacting = true;
    // Snapshot the current compactCount — refreshTranscript will keep
    // isCompacting sticky until compactCount advances past this baseline,
    // i.e. a real compact_boundary lands in the transcript.
    if (session.ptyCompactBaseline === undefined) {
      session.ptyCompactBaseline = session.compactCount ?? 0;
      session.ptyCompactBaselineAt = now;
      session.ptyCompactBoundarySeen = undefined;
    }
    this.onChange();
  }

  /** Normalize an incoming id (may be ovrId or Claude sessionId) to the active Claude sessionId.
   *  Override maps (lastPtyActivityAt, bridgeActiveOverride) are read by Claude sessionId in
   *  addOrUpdate, so writers that receive ovrId must translate first. */
  private toClaudeId(id: string): string {
    return this.sessionsByOvrId.get(id) ?? id;
  }

  /** Record PTY output activity for a session — overrides stale 'waiting' state in snapshot. */
  setPtyActive(sessionId: string): void {
    const claudeId = this.toClaudeId(sessionId);
    const until = this.suppressPromoteUntil.get(claudeId);
    if (until && Date.now() < until) {
      // Suppressed: don't bump lastPtyActivityAt and don't promote. This is for self-induced
      // PTY redraws (e.g. shift+tab status-bar refresh) that shouldn't flip WAITING→WORKING.
      return;
    }
    this.lastPtyActivityAt.set(claudeId, Date.now());
    this.promoteToWorkingIfWaiting(claudeId);
  }

  /** Suppress the next ~durationMs of PTY-activity-driven WAITING→WORKING promotion for this session.
   *  Used when we inject input (shift+tab) that causes a brief redraw we shouldn't mistake for work. */
  suppressPtyPromotion(sessionId: string, durationMs: number): void {
    const claudeId = this.toClaudeId(sessionId);
    this.suppressPromoteUntil.set(claudeId, Date.now() + durationMs);
  }

  /** Persistently mark a bridge session as active (spinner detected). Cleared when idle prompt seen. */
  setBridgeActive(sessionId: string, active: boolean): void {
    const claudeId = this.toClaudeId(sessionId);
    const was = this.bridgeActiveOverride.has(claudeId);
    if (active) {
      this.bridgeActiveOverride.add(claudeId);
      this.promoteToWorkingIfWaiting(claudeId);
    } else {
      this.bridgeActiveOverride.delete(claudeId);
    }
    // Only broadcast when the active flag actually flipped. Spinner ticks hit
    // this setter dozens of times per second with the same value and used to
    // trigger a full snapshot rebuild + fan-out on every chunk.
    if (was !== active) this.onChange();
  }

  /** Flip 'waiting' → 'working' immediately when terminal activity is detected,
   *  without waiting for the next transcript write. Guarded by activityFeed so
   *  brand-new sessions emitting startup output don't get promoted. */
  private promoteToWorkingIfWaiting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state !== 'waiting') return;
    if (!session.activityFeed || session.activityFeed.length === 0) return;
    session.state = 'working';
    session.completionHint = undefined;
    session.completionHintByUser = false;
    this.onChange();
  }

  /** Mark that the user has typed non-Enter input in the PTY terminal. */
  setPtyInputPending(sessionId: string): void {
    if (!this.ptyInputPendingSince.has(sessionId)) {
      const since = Date.now();
      this.ptyInputPendingSince.set(sessionId, since);
      // Also mutate the stored session object so getSnapshot() sees the new value immediately.
      const session = this.sessions.get(sessionId);
      if (session) session.ptyInputPendingSince = since;
      this.onChange();
    }
  }

  /** Clear pending PTY input (user pressed Enter). */
  clearPtyInputPending(sessionId: string): void {
    if (this.ptyInputPendingSince.has(sessionId)) {
      this.ptyInputPendingSince.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) session.ptyInputPendingSince = undefined;
      this.onChange();
    }
  }

  setPermissionMode(sessionId: string, mode: string | undefined): void {
    // Callers pass either a Claude sessionId or an ovrId. Normalize so the PTY-output
    // path (which only knows ovrId) still hits the right session.
    const claudeId = this.toClaudeId(sessionId);
    const session = this.sessions.get(claudeId);
    if (!session) return;
    // Any realtime source (PTY detection, cycle endpoint, bridge handler, screen reader)
    // permanently wins over the transcript's permissionMode field. The transcript value
    // lags by design — it reflects what Claude wrote with the last user message, not the
    // current status bar — so once a realtime source has spoken we trust it indefinitely.
    // The next realtime call overwrites this value directly.
    session.permissionModeLockedUntil = Number.MAX_SAFE_INTEGER;
    if (session.permissionMode !== mode) {
      session.permissionMode = mode;
      this.onChange();
    }
  }

  updateAlivePids(pids: Set<number>): void {
    let anyChanged = false;
    for (const session of this.sessions.values()) {
      if (session.provider === 'codex' || session.pid <= 0) continue;
      if (session.sessionType === 'raw') continue;
      if (session.provider === 'opencode' && !session.transcriptPath && session.state !== 'closed') {
        const lastPtyAt = this.lastPtyActivityAt.get(session.sessionId);
        const shouldBeWorking = lastPtyAt != null && Date.now() - lastPtyAt < 5000;
        const nextState: WorkerState = shouldBeWorking ? 'working' : 'waiting';
        if (session.state !== nextState) {
          session.state = nextState;
          anyChanged = true;
        }
      }
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
          const transcriptPath = resolveTranscriptPath(session);
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
        clearSessionCaches(sessionId, session.transcriptPath, session.cwd);
        this.sessions.delete(sessionId);
        anyChanged = true;
        continue;
      }
      // Remove old closed sessions with no activity for >30 minutes.
      // Use loadedAt (set to Date.now() when session is added) so that sessions
      // recovered from transcripts on startup aren't immediately GC'd.
      if (session.state === 'closed' && session.pid === 0) {
        const age = now - (session.loadedAt ?? new Date(session.lastActivity ?? session.startedAt).getTime());
        if (age > thirtyMin) {
          clearSessionCaches(sessionId, session.transcriptPath, session.cwd);
          this.sessions.delete(sessionId);
          anyChanged = true;
        }
      }
    }
    // Prune processSnapshot of PIDs that no longer exist (cap growth from fallback inserts).
    // Cheap guard: if snapshot is much larger than session count, refresh it.
    if (this.processSnapshot.size > 2000) {
      this.refreshProcessSnapshot();
    }
    // Sweep orphan query-worker session files (left behind if claudeQuery's
    // cleanup hook didn't fire — e.g. forced kill). Cheap: only a few files.
    sweepOrphanQueryWorkerFiles();
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

  getPtySessionsToResume(): Array<{ sessionId: string; cwd: string; provider?: Session['provider']; providerSessionId?: string }> {
    return [...this.sessions.values()]
      .filter(s => s.sessionType === 'embedded' && s.state === 'closed')
      .map(s => ({ sessionId: s.sessionId, cwd: s.cwd, provider: s.provider, providerSessionId: s.providerSessionId }));
  }

  getSnapshot(): OfficeSnapshot {
    const roomMap = new Map<string, Room>();

    for (const session of this.sessions.values()) {
      if (session.replacedBy) continue;
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
      roomMap.get(cwd)!.sessions.push(this.projectLatestPlan(session));
    }

    const rooms = Array.from(roomMap.values());

    rooms.sort((a, b) => a.name.localeCompare(b.name));

    // Sort sessions within each room by startedAt
    for (const room of rooms) {
      room.sessions.sort((a, b) => a.startedAt - b.startedAt);
    }

    // Attach git branch (and watch for changes) per room cwd
    const activeCwds = new Set<string>();
    for (const room of rooms) {
      activeCwds.add(room.cwd);
      const branch = this.gitWatcher.watch(room.cwd);
      if (branch) {
        room.gitBranch = branch;
        const pr = this.prCache.get(room.cwd, branch);
        if (pr) room.pullRequest = pr;
        const prErr = this.prCache.getError(room.cwd, branch);
        if (prErr) room.gitWarning = `PR lookup: ${prErr}`;
        const aheadEntry = this.gitAheadCache.get(room.cwd);
        if (aheadEntry && aheadEntry.ahead > 0) room.gitAhead = aheadEntry.ahead;
      }
      const cfg = readRoomConfig(room.cwd);
      if (cfg.description) room.description = cfg.description;
    }
    this.gitWatcher.retain(activeCwds);
    this.prCache.retain(activeCwds);

    return {
      rooms,
      updatedAt: new Date().toISOString(),
      bridgePath: this.bridgePath,
      platform: process.platform,
      settings: globalSettingsStore.get(),
    };
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  private projectLatestPlan(session: Session): Session {
    const plans = planStore.listByOverlord(session.overlordId);
    if (plans.length === 0) return session;
    const latest = plans
      .filter(p => p.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest) return session;
    return {
      ...session,
      latestPlan: {
        planId: latest.planId,
        title: latest.title,
        body: latest.body,
        status: latest.status,
        claudePlanToolUseId: latest.claudePlanToolUseId,
        updatedAt: latest.updatedAt,
      },
    };
  }

  /** Exposed so on-demand git-status endpoint can share the single PR cache. */
  getPrCache(): PrCache {
    return this.prCache;
  }

  /**
   * Find a session by pid, optionally gated on startedAt matching.
   *
   * The startedAt guard prevents a false /clear detection when a new PTY
   * process transiently writes the parent sessionId (during `claude --resume`).
   * A real in-place /clear preserves startedAt; a second resume or pid reuse
   * has a different startedAt. Callers doing /clear detection MUST pass
   * startedAt; callers that genuinely need any pid match may omit it.
   */
  findSessionByPid(pid: number, excludeSessionId: string, startedAt?: number): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.pid !== pid) continue;
      if (session.sessionId === excludeSessionId) continue;
      if (startedAt !== undefined && session.startedAt !== startedAt) continue;
      return session;
    }
    return undefined;
  }

  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Default avatar color for new sessions. */
  private static readonly DEFAULT_COLOR = 'hsl(30, 75%, 55%)';

  /** Look up the color for a session by claudeSessionId. Resolves ovrId internally. */
  sessionColor(sessionId: string): string {
    const ovrId = this.sessions.get(sessionId)?.overlordId;
    if (ovrId && this.colorOverrides.has(ovrId)) return this.colorOverrides.get(ovrId)!;
    return StateManager.DEFAULT_COLOR;
  }

  /** Look up the color for an ovrId directly. */
  sessionColorByOvrId(ovrId: string): string {
    return this.colorOverrides.get(ovrId) ?? StateManager.DEFAULT_COLOR;
  }

  /** Set a custom color for a session (keyed by its ovrId) and persist. */
  setSessionColor(sessionId: string, color: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.overlordId) return false;
    this.colorOverrides.set(session.overlordId, color);
    session.color = color;
    this.saveColors();
    this.onChange();
    return true;
  }

  /**
   * Rename a session. Updates the durable OverlordSession.proposedName and the
   * live Session so the next snapshot carries the new name. Accepts both live
   * and archived sessions — archived records patch through sessionStore only.
   * Pass an empty string to clear the name.
   *
   * sessionStore (OverlordSession) is the durable write path for proposedName;
   * known-sessions.json no longer carries the field and loadKnownSessions()
   * reads it back from sessionStore on boot.
   */
  setSessionName(sessionId: string, name: string): boolean {
    const trimmed = name.trim();
    const next = trimmed.length > 0 ? trimmed : undefined;

    let rec = sessionStore.getBySessionId(sessionId);
    const live = this.sessions.get(sessionId);
    if (!rec && live) rec = sessionStore.ensureFromLive(live);
    if (!rec) return false;

    sessionStore.patch(rec.overlordId, { proposedName: next });
    if (live) {
      live.proposedName = next;
      this.onChange();
    }
    return true;
  }

  private loadColors(): void {
    try {
      if (!fs.existsSync(this.colorsFile)) return;
      const data = JSON.parse(fs.readFileSync(this.colorsFile, 'utf-8')) as Record<string, string>;
      for (const [ovrId, color] of Object.entries(data)) {
        this.colorOverrides.set(ovrId, color);
      }
    } catch { /* ignore */ }
  }

  private saveColors(): void {
    try {
      const dir = path.dirname(this.colorsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [ovrId, color] of this.colorOverrides) obj[ovrId] = color;
      fs.writeFileSync(this.colorsFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch { /* ignore */ }
  }

  /**
   * Re-hydrate a previously archived session back into stateManager.sessions
   * after unarchive. Caller must have already restored the transcript into
   * ~/.claude/projects and moved the sessionStore record back to active.
   *
   * Clears the deleted blocklist entry (archive's deleteSession path added it),
   * loads transcript state, and inserts as 'closed' so it renders in the room.
   */
  rehydrateFromSessionStore(sessionId: string): Session | null {
    const rec = sessionStore.getBySessionId(sessionId);
    if (!rec) return null;

    this.undelete(sessionId);

    const transcriptPath = findTranscriptPath(rec.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);

    let transcriptState: ReturnType<typeof readTranscriptState> | null = null;
    if (transcriptPath) {
      try { transcriptState = readTranscriptState(transcriptPath); } catch { /* ignore */ }
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.state = 'closed';
      if (transcriptState?.lastActivity) existing.lastActivity = transcriptState.lastActivity;
      this.onChange();
      return existing;
    }

    const startedAt = rec.startedAt ?? Date.now();
    const session: Session = {
      sessionId,
      overlordId: rec.overlordId,
      sessionHistory: rec.lineage.history.map(h => ({ sessionId: h.sessionId, attachedAt: h.attachedAt })),
      provider: rec.provider ?? 'claude',
      providerSessionId: rec.providerSessionId,
      pid: 0,
      cwd: rec.cwd,
      startedAt,
      state: 'closed',
      lastActivity: transcriptState?.lastActivity ?? new Date(startedAt).toISOString(),
      lastMessage: transcriptState?.lastMessage ?? rec.lastMessage,
      activityFeed: transcriptState?.activityFeed,
      model: transcriptState?.model ?? rec.model,
      inputTokens: transcriptState?.inputTokens,
      compactCount: transcriptState?.compactCount,
      isCompacting: false,
      proposedName: rec.proposedName,
      sessionType: rec.sessionType,
      color: rec.color,
      subagents: [],
      resumedFrom: rec.resumedFrom,
      replacedBy: rec.replacedBy,
      bridgePipeName: rec.bridgePipeName,
      bridgeMarker: rec.bridgeMarker,
      transcriptPath: transcriptPath ?? undefined,
      intent: rec.intent,
      acknowledged: rec.acknowledged,
      userAccepted: rec.userAccepted,
      historyOnly: rec.historyOnly,
      loadedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(rec.overlordId, sessionId);
    this.saveKnownSessions();
    this.onChange();
    return session;
  }

  async loadClosedSessionsFromTranscripts(): Promise<void> {
    const t0 = Date.now();
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;

    const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    let scanned = 0, skippedAge = 0, loaded = 0;

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
        scanned++;
        try {
          // Fast skip: don't read files not modified in the last 24 hours.
          // stat.mtime is cheap; readFileSync on 1000+ files is the OOM culprit.
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          try {
            const stat = fs.statSync(transcriptPath);
            if (stat.mtime < oneDayAgo) { skippedAge++; continue; }
          } catch { continue; }

          // Read only the first few lines for cwd + startedAt (NOT the whole file)
          const headBuf = Buffer.alloc(4096);
          const fd = fs.openSync(transcriptPath, 'r');
          const bytesRead = fs.readSync(fd, headBuf, 0, 4096, 0);
          fs.closeSync(fd);
          const headLines = headBuf.subarray(0, bytesRead).toString('utf-8').split('\n');

          let cwd: string | undefined;
          let startedAt = 0;
          for (const line of headLines.slice(0, 10)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (!cwd && entry.cwd) { cwd = entry.cwd as string; }
              if (!startedAt && entry.timestamp) { startedAt = new Date(entry.timestamp).getTime(); }
              if (cwd && startedAt) break;
            } catch { continue; }
          }
          if (!cwd) continue;

          // Skip internal Overlord worker sessions (cwd is inside ~/.claude/)
          const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/');
          if (cwdNorm.includes('/.claude/')) continue;

          // Read transcript state (reads only tail of file)
          const transcriptState = readTranscriptState(transcriptPath);

          // Skip sessions inactive for more than 24 hours (double-check via transcript content)
          if (transcriptState.lastActivity && new Date(transcriptState.lastActivity) < oneDayAgo) continue;

          const proposedName = readProposedName(sessionId, transcriptPath);
          const subagents = readSubagents(cwd, sessionId, transcriptPath);

          const recoveredOvrId = this.generateOvrId();
          this.sessionsByOvrId.set(recoveredOvrId, sessionId);
          const color = this.sessionColorByOvrId(recoveredOvrId);
          const session: Session = {
            sessionId,
            overlordId: recoveredOvrId,
            provider: 'claude',
            providerSessionId: undefined,
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
            transcriptPath,
            loadedAt: Date.now(),
          };

          this.sessions.set(sessionId, session);
          loaded++;
        } catch {
          // Skip unreadable transcripts
          continue;
        }
      }
    }

    console.log(`[startup] loadClosedSessions: ${Date.now() - t0}ms | scanned=${scanned} skippedAge=${skippedAge} loaded=${loaded} total=${this.sessions.size}`);
    if (this.sessions.size > 0) {
      this.onChange();
    }
  }

  /** Delete transcript files not modified in 7+ days and not used by any active session.
   *  Worker transcripts (overlord-query-worker, overlord-haiku-worker) use a 1-day TTL. */
  async cleanupStaleTranscripts(): Promise<void> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;

    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const WORKER_STALE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const activeIds = new Set(this.sessions.keys());
    let deleted = 0;
    let kept = 0;

    const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const slug of slugDirs) {
      const isWorkerSlug = /worker/i.test(slug);
      const cutoff = now - (isWorkerSlug ? WORKER_STALE_MS : STALE_MS);
      const slugDir = path.join(projectsDir, slug);
      let files: string[];
      try { files = fs.readdirSync(slugDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (!/^[0-9a-f-]{36}$/.test(sessionId)) continue;

        // Never delete transcripts for active/known sessions
        if (activeIds.has(sessionId)) { kept++; continue; }

        const filePath = path.join(slugDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs > cutoff) { kept++; continue; }
          fs.unlinkSync(filePath);
          // Also remove subagent dir if it exists
          const subagentDir = path.join(slugDir, sessionId);
          if (fs.existsSync(subagentDir)) {
            fs.rmSync(subagentDir, { recursive: true, force: true });
          }
          deleted++;
        } catch { /* skip unreadable */ }
      }
    }

    if (deleted > 0) {
      console.log(`[cleanup] deleted ${deleted} stale transcripts (workers>1d, others>7d), kept ${kept}`);
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
    const normalizedCwd = normalizePath(cwd);
    const cacheKey = `${ideDir}|${normalizedCwd}`;
    const cached = this.ideNameCache.get(cacheKey);
    if (cached && cached.mtimeMs === dirMtime) return cached.result;

    let result: { name: string; idePid: number } | undefined;
    try {
      const files = fs.readdirSync(ideDir);
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
    if (this.ideNameCache.size >= StateManager.IDE_NAME_CACHE_CAP) {
      // FIFO eviction: drop the oldest insertion (Map iteration order)
      const firstKey = this.ideNameCache.keys().next().value;
      if (firstKey !== undefined) this.ideNameCache.delete(firstKey);
    }
    this.ideNameCache.set(cacheKey, { mtimeMs: dirMtime, result });
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
            return info;
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }
}
