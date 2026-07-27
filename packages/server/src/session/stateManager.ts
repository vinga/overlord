import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { Session, Room, OfficeSnapshot, WorkerState, Subagent, OverlordSession, JiraIssueMeta, PendingQuestionSet, PlanSummary, WorkerIcon, BackgroundTask } from '../types.js';
import { getBridgePath } from '../pty/pipeInjector.js';
import { GitWatcher } from '../git/gitWatcher.js';
import { PrCache } from '../git/prCache.js';
import { PrHistoryStore } from '../git/prHistoryStore.js';
import { readGitStatus } from '../git/gitStatus.js';
import { derivePipeNameFromMarker } from '../bridge/bridgeNameUtils.js';
import { readRoomConfig, listConfiguredRoomSlugs, slugForCwd } from './roomConfig.js';
import { sessionStore, scrubReplacedBy } from './sessionStore.js';
import { migrateKnownSessions } from './migrateKnownSessions.js';
import { migratePendingResumes } from './migratePendingResumes.js';
import { migrateDeletedSessions } from './migrateDeletedSessions.js';
import { globalSettingsStore } from './globalSettingsStore.js';
import { getCachedJiraMeta } from './jiraTitleCache.js';
import { ClearLifecycleManager } from './clearLifecycleManager.js';
import { PtyResumeTracker } from './ptyResumeTracker.js';
import { OvrIdReservation } from './ovrIdReservation.js';
import { normalizePath } from './pathNormalize.js';
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

/**
 * Pure selection for the hourly archived-PR refresh. Given the set of currently
 * active room cwds, the universe of known cwds, and a per-cwd PR-history lookup,
 * returns the (cwd, branch) worklist to refresh: archived/closed rooms only
 * (active excluded — they already poll on the live TTL) and only entries whose
 * last-known state is not MERGED (terminal). Deduped by cwd+branch. Extracted
 * from StateManager so it can be unit-tested without booting the server.
 */
export function selectArchivedPrTargets(
  activeCwds: Set<string>,
  allCwds: Iterable<string>,
  historyFor: (cwd: string) => Array<{ state: string; branch: string }>,
): Array<{ cwd: string; branch: string }> {
  const candidateCwds = new Set<string>();
  for (const cwd of allCwds) {
    if (cwd && !activeCwds.has(cwd)) candidateCwds.add(cwd);
  }
  const seen = new Set<string>();
  const targets: Array<{ cwd: string; branch: string }> = [];
  for (const cwd of candidateCwds) {
    for (const entry of historyFor(cwd)) {
      if (entry.state === 'MERGED') continue; // terminal — never re-poll
      if (!entry.branch) continue;
      const key = `${cwd}\n${entry.branch}`; // newline: safe vs spaces in mac paths
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ cwd, branch: entry.branch });
    }
  }
  return targets;
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
import { ensureShadow } from './transcriptShadow.js';
import type { RawSession } from './sessionWatcher.js';
import { saveAck, loadAck } from '../ai/taskStorage.js';
import { artifactStore } from '../artifacts/artifactStore.js';
import type { ArtifactStatus } from '../artifacts/types.js';

function planStatusFromClaude(status: 'approved' | 'rejected' | 'pending'): ArtifactStatus {
  if (status === 'approved') return 'active';
  if (status === 'rejected') return 'archived';
  return 'draft';
}

function derivePlanTitle(plan: string): string {
  const firstLine = plan.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? 'Plan';
  const stripped = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '');
  return stripped.length > 80 ? stripped.slice(0, 77) + '…' : stripped;
}

/** Tail length for activityFeed in WS snapshots. DetailPanel lazy-loads older
 *  items via REST (`/api/sessions/:id/activity-before`) when the user scrolls
 *  past this boundary. Lowered from 200 → 30 because the first snapshot was
 *  shipping 2.4MB at N=26 sessions, and parsing/rendering that on the client
 *  caused a multi-second blank UI on reconnect/restart. 30 items covers the
 *  visible tail of the detail panel without scrolling. */
const SNAPSHOT_FEED_TAIL = 30;

function trimActivityFeed<T>(feed: T[] | undefined): T[] | undefined {
  if (!feed || feed.length <= SNAPSHOT_FEED_TAIL) return feed;
  return feed.slice(feed.length - SNAPSHOT_FEED_TAIL);
}

function trimSubagentFeeds(subs: Subagent[] | undefined): Subagent[] | undefined {
  if (!subs || subs.length === 0) return subs;
  let changed = false;
  const out: Subagent[] = [];
  for (const s of subs) {
    const trimmed = trimActivityFeed(s.activityFeed);
    if (trimmed !== s.activityFeed) {
      changed = true;
      out.push({ ...s, activityFeed: trimmed });
    } else {
      out.push(s);
    }
  }
  return changed ? out : subs;
}

const JIRA_KEYS_MAX = 5;
const JIRA_DISMISSED_MAX = 50;
/** Union-merge two ordered key lists (existing first, then new), de-duplicated,
 *  capped, and with any user-dismissed keys filtered out. */
function mergeJiraKeys(
  existing: string[] | undefined,
  fresh: string[] | undefined,
  dismissed?: string[],
): string[] | undefined {
  if (!existing?.length && !fresh?.length) return undefined;
  const blocked = dismissed && dismissed.length > 0 ? new Set(dismissed) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of existing ?? []) {
    if (seen.has(k) || (blocked && blocked.has(k))) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= JIRA_KEYS_MAX) return out;
  }
  for (const k of fresh ?? []) {
    if (seen.has(k) || (blocked && blocked.has(k))) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= JIRA_KEYS_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

const SKILLS_USED_MAX = 12;
/** Union-merge for skill/command names — same shape as mergeJiraKeys, no dismissed list. */
export function mergeSkillsUsed(
  existing: string[] | undefined,
  fresh: string[] | undefined,
): string[] | undefined {
  if (!existing?.length && !fresh?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [...(existing ?? []), ...(fresh ?? [])]) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= SKILLS_USED_MAX) break;
  }
  return out.length > 0 ? out : undefined;
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

/** Membership-only comparison of pending background tasks. `lastOutputAt` moves
 *  every time the command writes a byte — comparing it would broadcast a snapshot
 *  on every poll for any session tailing a chatty background job. */
function backgroundTasksEqual(a: BackgroundTask[] | undefined, b: BackgroundTask[] | undefined): boolean {
  if (a === b) return true;
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  if (!a || !b) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toolUseId !== b[i].toolUseId) return false;
  }
  return true;
}

function resolveTranscriptPath(session: {
  cwd: string;
  sessionId: string;
  resumedFrom?: string;
  transcriptPath?: string;
}): string | null {
  // Canonical sessionId-derived path always wins when it exists. A cached
  // transcriptPath may point to the parent file from --fork-session, set
  // before the new fork's jsonl was written; canonical must override it
  // once the fork file appears.
  const canonical = findTranscriptPath(session.cwd, session.sessionId);
  if (canonical) return canonical;
  if (session.transcriptPath && fs.existsSync(session.transcriptPath)) {
    return session.transcriptPath;
  }
  const anywhere = findTranscriptPathAnywhere(session.sessionId);
  if (anywhere) return anywhere;
  if (session.resumedFrom) {
    return findTranscriptPath(session.cwd, session.resumedFrom) ?? findTranscriptPathAnywhere(session.resumedFrom);
  }
  return null;
}

export class StateManager {
  private sessions: Map<string, Session> = new Map();
  private onChangeCallback: () => void;
  private onChangePending = false;
  private broadcastSuppressed = false;
  private resumeTracker = new PtyResumeTracker();
  /** Sid → expiry epoch ms. Defensive guard against the brief window between
   *  `markDeleted` (sync) and the deferred file unlinks in `deleteSession`.
   *  In-memory only — restart-survival is unnecessary because every backing
   *  file is unlinked before the next boot. Replaces deleted-sessions.json. */
  private recentlyDeletedSids: Map<string, number> = new Map();
  private static readonly DELETED_SID_TTL_MS = 60_000;
  private static readonly IDE_NAME_CACHE_CAP = 64;
  private ideNameCache = new Map<string, { mtimeMs: number; result: { name: string; idePid: number } | undefined }>();
  /** Full process snapshot for fast chain walks — populated on startup, refreshed lazily. */
  private processSnapshot = new Map<number, { parentPid: number; name: string }>();
  private processSnapshotAge = 0;
  private gitAheadInFlight = false;
  private clearLifecycle = new ClearLifecycleManager();
  getPendingClearSessions(): string[] { return this.clearLifecycle.getInFlightSessions(); }
  /** Force-clear inFlight state for a session (recovery path when /clear got
   *  marked but the replacement transcript never arrived). Returns true if a
   *  flag was actually cleared. */
  forceCompleteClear(sessionId: string): boolean {
    const had = this.clearLifecycle.isInFlight(sessionId);
    this.clearLifecycle.completeReplacement(sessionId);
    if (had) this.refreshTranscript(sessionId);
    return had;
  }
  /**
   * Legacy colors.json is migrated into sessionStore on boot. The single source
   * of truth for per-lineage color is `OverlordSession.color` (one file per ovrId
   * under `~/.claude/overlord/overlord-sessions/`). There is no in-memory cache —
   * `sessionColorByOvrId` looks it up through `sessionStore` on demand.
   */
  private readonly legacyColorsFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/colors.json');
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
  private prHistoryStore: PrHistoryStore;
  private gitAheadCache = new Map<string, { ahead: number; cachedAt: number }>();
  private gitAheadTimer: ReturnType<typeof setInterval> | null = null;
  private archivePrTimer: ReturnType<typeof setInterval> | null = null;
  private archivePrBootTimer: ReturnType<typeof setTimeout> | null = null;
  /** Injected from index.ts after construction — reports whether an ovrId has a live PTY in `ovrToPty`.
   *  Stamped into every snapshot so the client can tell "embedded + live" from "embedded + orphan". */
  private hasLivePtyFn: (ovrId: string) => boolean = () => false;
  setHasLivePtyFn(fn: (ovrId: string) => boolean): void { this.hasLivePtyFn = fn; }

  private ovrIdReservation = new OvrIdReservation();

  private generateOvrId(): string { return this.ovrIdReservation.generate(); }
  mintReservedOvrId(marker: string): string { return this.ovrIdReservation.mint(marker); }
  reserveOvrIdForMarker(marker: string, ovrId: string): void { this.ovrIdReservation.reserveForMarker(marker, ovrId); }
  consumeReservedOvrIdForMarker(marker: string): string | undefined { return this.ovrIdReservation.consumeByMarker(marker); }
  reserveOvrIdForPid(pid: number, ovrId: string): void { this.ovrIdReservation.reserveForPid(pid, ovrId); }
  consumeReservedOvrIdForPid(pid: number): string | undefined { return this.ovrIdReservation.consumeByPid(pid); }

  /** Return the active session for a given overlordId. */
  getActiveClaudeByOvr(ovrId: string): Session | undefined {
    const claudeId = this.sessionsByOvrId.get(ovrId);
    return claudeId ? this.sessions.get(claudeId) : undefined;
  }

  /**
   * Re-key a live session onto an existing overlordId, dropping its previous
   * ovrId→sid mapping. Used when an unmarked `--fork-session` fork must adopt the
   * PTY's stable ovrId so the client's ovrId-keyed selection survives the swap.
   * Returns the ovrId the session previously held (caller may purge its throwaway
   * OverlordSession record).
   */
  adoptOverlordId(sessionId: string, targetOvrId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const prev = s.overlordId;
    if (prev === targetOvrId) return prev;
    if (prev && this.sessionsByOvrId.get(prev) === sessionId) {
      this.sessionsByOvrId.delete(prev);
    }
    s.overlordId = targetOvrId;
    this.sessionsByOvrId.set(targetOvrId, sessionId);
    return prev;
  }

  /** Drop a throwaway OverlordSession record (e.g. the fresh ovrId a fork minted
   *  before it adopted the PTY's stable ovrId). No-op if still referenced. */
  dropOvrRecord(ovrId: string): void {
    for (const s of this.sessions.values()) {
      if (s.overlordId === ovrId) return; // still in use — keep it
    }
    sessionStore.remove(ovrId);
  }

  constructor(onChange: () => void) {
    this.bridgePath = getBridgePath();
    this.onChangeCallback = onChange;
    this.gitWatcher = new GitWatcher(() => this.onChange());
    this.prHistoryStore = new PrHistoryStore();
    this.prCache = new PrCache(() => this.onChange(), this.prHistoryStore);
    this.gitAheadTimer = setInterval(() => { void this.refreshGitAheadCache(); }, 15_000);
    // Hourly background refresh of PR state for archived/closed rooms (live
    // rooms already poll on the 15-min HIT TTL). Non-destructive + REST-only +
    // gated by env, so default-ON is acceptable. First run is delayed off boot.
    if (process.env.OVERLORD_ARCHIVE_PR_REFRESH !== '0' && process.env.OVERLORD_ARCHIVE_PR_REFRESH !== 'false') {
      this.archivePrBootTimer = setTimeout(() => { void this.refreshArchivedPrs(); }, 90_000);
      this.archivePrBootTimer.unref?.();
      this.archivePrTimer = setInterval(() => { void this.refreshArchivedPrs(); }, 60 * 60 * 1000);
      this.archivePrTimer.unref?.();
    }
    this.migrateLegacyColors();
    migrateKnownSessions();
    // migratePendingResumes(); // in-progress — symbol not imported, crashes boot
    migrateDeletedSessions();
    this.hydrateAllActiveSessions();
    // Clear stale replacedBy pointers (self-ref + orphan-successor). Both
    // would otherwise permanently hide an active session from the snapshot.
    const scrub = scrubReplacedBy();
    if (scrub.selfRef.length + scrub.orphanSuccessor.length > 0) {
      console.log(`[boot] scrubReplacedBy: self-ref=${scrub.selfRef.length} orphan-successor=${scrub.orphanSuccessor.length}`);
    }
    this.refreshProcessSnapshot(); // one OS call, populates parentPidCache for all processes
    this.migrateLegacyBridgeRegistry();
    this.hydratePendingResumesFromSessionStore();
    void this.refreshGitAheadCache();
    this.logBootSummary();
  }

  /** Refresh the full process snapshot (one OS call). */
  private refreshProcessSnapshot(): void {
    this.processSnapshot = getAllProcessInfo();
    this.processSnapshotAge = Date.now();
  }

  /** Sweep `git status` across the rooms that have a live session, refreshing the
   *  ahead-count cache. Serial by design — a parallel fan-out would spawn one git
   *  per repo at once.
   *
   *  Re-entrancy guard: this is `async` but was driven by a bare 15s setInterval.
   *  Each sweep spawns one `git status --untracked-files=all` per cwd (0.1–0.4s
   *  each), so a slow sweep overran its own interval and the next one started on
   *  top of it, stacking blocking `posix_spawn` calls on the event loop. Skip the
   *  tick instead — the cache is advisory and the next tick is 15s away. */
  private async refreshGitAheadCache(): Promise<void> {
    if (this.gitAheadInFlight) return;
    this.gitAheadInFlight = true;
    try {
      // Closed sessions don't need a live ahead-count on a 15s cadence, and they
      // outnumber live ones ~20:1 on a long-running server. Sweep live rooms only.
      const cwds = new Set<string>();
      for (const session of this.sessions.values()) {
        if (session.cwd && session.state !== 'closed') cwds.add(session.cwd);
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
    } finally {
      this.gitAheadInFlight = false;
    }
  }

  /** Distinct cwds with a live/hydrated session — i.e. the rooms the snapshot
   *  surfaces and `prCache` keeps fresh on the 15-min TTL. Used to exclude
   *  active rooms from the archived-PR refresh so we never double-poll. */
  private activeRoomCwds(): Set<string> {
    const out = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.cwd) out.add(session.cwd);
    }
    return out;
  }

  /** Build the archived-PR refresh worklist: every (cwd, branch) from
   *  pr-history whose room is NOT currently active and whose last-known state
   *  is not yet MERGED (terminal). Deduped by cwd+branch. Pure — no I/O beyond
   *  the in-memory/disk-backed stores it reads. Extracted for unit testing. */
  computeArchivedPrRefreshTargets(): Array<{ cwd: string; branch: string }> {
    const allCwds = new Set<string>();
    for (const rec of sessionStore.listAll()) {
      if (rec.cwd) allCwds.add(rec.cwd);
    }
    return selectArchivedPrTargets(
      this.activeRoomCwds(),
      allCwds,
      cwd => this.prHistoryStore.list(cwd),
    );
  }

  /** Hourly job: refresh PR state for archived/closed rooms whose PR is not yet
   *  merged. Sequenced with a small gap so we never burst `gh` forks on a
   *  loaded machine. Each refresh records fresh state into prHistoryStore. */
  private async refreshArchivedPrs(): Promise<void> {
    const targets = this.computeArchivedPrRefreshTargets();
    if (targets.length === 0) return;
    for (const { cwd, branch } of targets) {
      try {
        await this.prCache.refreshForHistory(cwd, branch);
      } catch {
        // ignore — error is cached on the entry; next hour retries
      }
      await new Promise<void>(r => setTimeout(r, 250)); // throttle gh forks
    }
  }

  private onChange(): void {
    if (this.onChangePending) return;
    this.onChangePending = true;
    // Throttle to 5Hz. setImmediate coalesces only within one event-loop tick;
    // a 200ms timer coalesces transcript changes, PTY output, classify hits,
    // etc. across many ticks. With N=20+ sessions the snapshot can be 100KB+ —
    // bunching broadcasts frees the WS pipe and event loop for PTY data streams
    // during session resume. UI feels live at 5Hz; raising further hurts
    // perceived responsiveness on state transitions.
    setTimeout(() => {
      this.onChangePending = false;
      if (this.broadcastSuppressed) return;
      this.onChangeCallback();
    }, 200);
  }

  /** Suppress snapshot broadcasts. Call resumeBroadcast() when done to fire one consolidated snapshot. */
  suppressBroadcast(): void {
    this.broadcastSuppressed = true;
  }

  resumeBroadcast(): void {
    this.broadcastSuppressed = false;
    this.onChange();
  }

  /** Rebuild the in-memory pendingResumes map from sessionStore on boot.
   *  Source of truth is `OverlordSession.pendingResume`. Expired entries are
   *  cleared on the OverlordSession and skipped. */
  private hydratePendingResumesFromSessionStore(): void {
    const { expiredOvrIds } = this.resumeTracker.hydrate(sessionStore.listActive());
    for (const ovrId of expiredOvrIds) {
      sessionStore.patch(ovrId, { pendingResume: undefined });
    }
  }

  /** Clear a pendingResume entry from the in-memory map and the OverlordSession. */
  private clearPendingResume(cwd: string): void {
    const cleared = this.resumeTracker.clearResume(cwd);
    if (!cleared) return;
    const ovrId = sessionStore.resolveOverlordIdAny(cleared);
    if (ovrId) sessionStore.patch(ovrId, { pendingResume: undefined });
  }

  /** Backfill bridgePipeName from the legacy `overlord-bridge-registry.json`
   *  for hydrated bridge sessions that lack it. Patches the OverlordSession too
   *  so the value survives subsequent restarts without the legacy file. */
  private migrateLegacyBridgeRegistry(): void {
    try {
      const registryPath = path.join(os.tmpdir(), 'overlord-bridge-registry.json');
      if (!fs.existsSync(registryPath)) return;
      const oldRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, string>;
      let migrated = false;
      for (const [sessionId, pipeName] of Object.entries(oldRegistry)) {
        const session = this.sessions.get(sessionId);
        if (session && session.sessionType === 'bridge' && !session.bridgePipeName && pipeName) {
          session.bridgePipeName = pipeName;
          if (session.overlordId) sessionStore.patch(session.overlordId, { bridgePipeName: pipeName });
          migrated = true;
        }
      }
      if (migrated) console.log('[stateManager] migrated bridge pipe names from old registry');
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
        if (this.isDeleted(currentSessionId)) continue;
        // The PID file has a different sessionId — /clear happened while we were down
        const newSession = this.sessions.get(currentSessionId);
        if (!newSession) continue; // new session not yet registered (shouldn't happen after sessionWatcher.start)
        console.log(`[clear:startup] PID ${session.pid} changed: ${oldSessionId.slice(0, 8)} → ${currentSessionId.slice(0, 8)}`);
        this.transferSessionState(oldSessionId, currentSessionId);
        // Mark old session as replaced. The OS rewrites {pid}.json in place so
        // the old sid will not reappear in the file scan; no tombstone needed.
        const old = this.sessions.get(oldSessionId);
        if (old) old.state = 'closed';
        this.onChange();
      } catch { /* ignore read errors */ }
    }
  }

  isDeleted(sessionId: string): boolean {
    const expiry = this.recentlyDeletedSids.get(sessionId);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.recentlyDeletedSids.delete(sessionId);
      return false;
    }
    return true;
  }

  undelete(sessionId: string): void {
    this.recentlyDeletedSids.delete(sessionId);
  }

  markDeleted(sessionId: string): void {
    this.recentlyDeletedSids.set(sessionId, Date.now() + StateManager.DELETED_SID_TTL_MS);
    const deletedSession = this.sessions.get(sessionId);
    clearSessionCaches(sessionId, deletedSession?.transcriptPath, deletedSession?.cwd);
    // Color lives on OverlordSession now; removing the lineage record via
    // sessionStore drops its color with it.
    this.sessions.delete(sessionId);
    this.onChange();
  }


  trackPendingResume(cwd: string, resumeSessionId: string): void {
    const { key, ts } = this.resumeTracker.trackResume(cwd, resumeSessionId);
    sessionStore.patchBySessionId(resumeSessionId, {
      pendingResume: { cwd: key, at: ts },
    });
  }

  trackPendingResumeByMarker(ptyId: string, resumeSessionId: string): void {
    this.resumeTracker.trackResumeByMarker(ptyId, resumeSessionId);
  }

  consumePendingResumeByMarker(ptyId: string): string | undefined {
    return this.resumeTracker.consumeResumeByMarker(ptyId);
  }

  /** Non-consuming marker peek — used by the skip-interim guard. */
  peekPendingResumeByMarker(ptyId: string): string | undefined {
    return this.resumeTracker.peekResumeByMarker(ptyId);
  }

  // Initial prompt queued at spawn time, keyed by the PTY marker (never cwd —
  // concurrent same-cwd spawns must not collide). Fired once the freshly
  // spawned PTY produces output (ptyEvents output handler).
  private pendingInitialPromptByMarker = new Map<string, { text: string; at: number }>();
  private static readonly INITIAL_PROMPT_TTL_MS = 120_000;

  trackPendingInitialPrompt(ptySessionId: string, text: string): void {
    this.pendingInitialPromptByMarker.set(ptySessionId, { text, at: Date.now() });
  }

  /** One-shot read: returns the queued prompt and removes it. Stale entries
   * (older than the TTL — spawn never produced output) are dropped, not fired. */
  takePendingInitialPrompt(ptySessionId: string): string | undefined {
    const e = this.pendingInitialPromptByMarker.get(ptySessionId);
    if (!e) return undefined;
    this.pendingInitialPromptByMarker.delete(ptySessionId);
    if (Date.now() - e.at > StateManager.INITIAL_PROMPT_TTL_MS) return undefined;
    return e.text;
  }

  hasPendingResume(cwd: string): boolean {
    return this.resumeTracker.hasResume(cwd);
  }

  getPendingResumeTarget(cwd: string): string | undefined {
    return this.resumeTracker.getResumeTarget(cwd);
  }

  trackPendingPtySpawn(cwd: string, ptySessionId?: string): void {
    const { staleResumeCleared } = this.resumeTracker.trackPtySpawn(cwd, ptySessionId);
    // A fresh spawn in this cwd invalidates any stale pendingResume
    // that was never consumed — it can no longer belong to this PTY.
    if (staleResumeCleared) {
      const ovrId = sessionStore.resolveOverlordIdAny(staleResumeCleared);
      if (ovrId) sessionStore.patch(ovrId, { pendingResume: undefined });
    }
  }

  addOrUpdate(raw: RawSession): { isNewWaiting: boolean; lastMessage?: string } {
    const { pid, sessionId, cwd } = raw;

    // Skip sessions that were explicitly deleted by the user
    if (this.isDeleted(sessionId)) {
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
      existingSession.startedAt !== raw.startedAt
    ) {
      console.log(
        `[stateManager] rejecting conflicting update for ${sessionId.slice(0, 8)}: ` +
        `existing pid=${existingSession.pid} startedAt=${existingSession.startedAt} (live), ` +
        `incoming pid=${pid} startedAt=${raw.startedAt} — likely concurrent --resume`
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
    const isFreshSpawn = markerMatch !== undefined && this.resumeTracker.isFreshSpawn(markerMatch);

    // Check for a pending resume: if this session was just resumed from another, link them.
    // Resolved early so the transcript fallback below can use it.
    let resumedFrom: string | undefined;
    if (existingSession?.resumedFrom) {
      resumedFrom = existingSession.resumedFrom;
    } else if (!isFreshSpawn) {
      // Marker-keyed lookup first: each resume spawn has its own ___OVR:<ptyId>
      // so concurrent resumes in the same cwd each find their own parent.
      if (markerMatch) {
        const byMarker = this.consumePendingResumeByMarker(markerMatch);
        if (byMarker) resumedFrom = byMarker;
      }
      if (!resumedFrom) {
        const target = this.resumeTracker.getResumeTarget(cwd);
        if (target) {
          resumedFrom = target;
          this.clearPendingResume(cwd);
        }
      }
    }
    // Guard against self-loop: when `--resume X` keeps the same sessionId
    // (Claude takes over the parent sid), the pending resume target equals
    // the incoming sid. Leaving resumedFrom === sessionId breaks transcript
    // fallback resolution and persists a broken record to sessionStore.
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
    const bridgeMarker = raw.name?.includes('___BRG:') ? raw.name.split('___BRG:')[1] : undefined;
    if (rawName?.includes('___BRG:')) rawName = rawName.split('___BRG:')[0];
    // Extract OVR marker (the value after ___OVR:, before any ___BRG:). Used both
    // for marker-based linking AND for adopting a pre-reserved ovrId minted by
    // the spawn site (see mintReservedOvrId). The marker may be a legacy pty-XXX
    // (still emitted by un-migrated spawn paths) or a fresh ovr-XXX (post-refactor).
    const ovrMarker = (() => {
      if (!raw.name?.includes('___OVR:')) return undefined;
      const after = raw.name.split('___OVR:')[1] ?? '';
      return after.split('___BRG:')[0] || undefined;
    })();
    // Resolve overlordId now (was previously below) so we can consult sessionStore
    // — the canonical source for proposedName — before falling back to rawName.
    // raw.name from {pid}.json is set at spawn time and never updated; if it
    // wins over the stored name, sentinel renames and user renames get
    // clobbered on every sessionWatcher tick (see OV Nell drift repro).
    // Consult sessionStore by sid first — its index covers `lineage.history`,
    // so any sid Overlord has ever attached reattaches to its owning record
    // instead of minting a duplicate ovr (repro: lineage advances past sid X,
    // a later transcript event for X spawns a fresh ovr for the same sid).
    // Also: bridge sessions carry `___BRG:<originalSid>` — when a bridged
    // claude reconnects with a fresh sid, the marker still names the
    // original; route the new sid into the original's lineage by ovrId
    // (otherwise we get duplicate Linden-style twin records).
    const resolvedOverlordId = existingSession?.overlordId
      ?? sessionStore.resolveOverlordId(sessionId)
      ?? (bridgeMarker ? sessionStore.resolveOverlordId(bridgeMarker) : undefined)
      // Adopt a pre-reserved ovrId minted at PTY spawn time. The marker
      // ___OVR:<ovrId> embedded in the spawn's --name flag carries the
      // reservation key. Consume on first match so subsequent matches mint fresh.
      ?? (ovrMarker ? this.consumeReservedOvrIdForMarker(ovrMarker) : undefined)
      // cwd-based fallback: session file arrived before --name was written
      // (Claude writes {pid}.json without name first, then updates). Look up
      // the ptyId registered for this cwd and consume its reserved ovrId.
      ?? (() => {
        const ptyId = this.resumeTracker.getPtyIdForCwd(cwd);
        return ptyId ? this.consumeReservedOvrIdForMarker(ptyId) : undefined;
      })()
      ?? (resumedFrom
        ? (sessionStore.resolveOverlordId(resumedFrom) ?? this.sessions.get(resumedFrom)?.overlordId)
        : undefined)
      // Last resort before mint: PID-keyed reservation. Set by auto-resume
      // when claude --resume drops the --name marker on the floor and we
      // need a way to re-attach the new sid to its lineage.
      ?? (raw.pid ? this.consumeReservedOvrIdForPid(raw.pid) : undefined);
    const stored = resolvedOverlordId ? sessionStore.getByOverlordId(resolvedOverlordId) : undefined;
    const storedName = stored?.proposedName?.startsWith('<local-command-caveat')
      ? undefined
      : stored?.proposedName;
    const existingName = existingSession?.proposedName?.startsWith('<local-command-caveat')
      ? undefined
      : existingSession?.proposedName;
    // Inherit the resumed-from session's name BEFORE falling back to rawName.
    // On boot, a /clear-driven new sid Y can land in addOrUpdate before the
    // sessionStore index merges Y into the hydrated lineage. storedName is then
    // undefined (resolveOverlordId misses Y), existingName is undefined (Y is
    // new in-memory), and the chain would drop to `rawName` — typically the
    // raw `--name` flag (slug/marker). The UI shows the slug for one tick,
    // then the real name once the lineage merge lands. Pulling from the
    // resumed-from session keeps the visible name stable across the merge.
    const resumedFromName = resumedFrom
      ? (this.sessions.get(resumedFrom)?.proposedName ?? sessionStore.getBySessionId(resumedFrom)?.proposedName)
      : undefined;
    const resolvedName = storedName
      ?? existingName
      ?? resumedFromName
      ?? (rawName || undefined)
      ?? (transcriptPath ? readProposedName(sessionId, transcriptPath) : undefined);
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
      // Prefer ptyId-keyed lookup when the ___OVR:<ptyId> marker is present —
      // each spawn has its own ptyId, so concurrent spawns in the same cwd
      // each get their own match. Cwd fallback retained for boot auto-resume
      // paths where the marker can be lost.
      const isFreshByMarker = ovrMarker
        ? this.resumeTracker.isFreshSpawn(ovrMarker)
        : false;
      const pendingTsByCwd = isFreshByMarker
        ? undefined
        : this.resumeTracker.getPtySpawnTs(cwd);
      // On Windows, process-tree traversal (isSpawnedByOverlord) is unreliable —
      // skip it there and rely on cwd + 5s timing alone. On macOS/Linux the check
      // is accurate and adds an extra guard against false positives.
      const isFreshByCwd = pendingTsByCwd != null
        && Date.now() - pendingTsByCwd < 5000
        && (process.platform === 'win32' || raw.pid === 0 || this.isSpawnedByOverlord(raw.pid));

      if (isFreshByMarker || isFreshByCwd) {
        sessionType = 'embedded';
        if (isFreshByMarker) this.resumeTracker.consumeFreshSpawn(ovrMarker!);
        else this.resumeTracker.consumePtySpawn(cwd);
      } else if (ovrMarker) {
        // Session name contains ___OVR:<marker> — it was definitively spawned by Overlord,
        // even if the server restarted and the freshPtySpawns map is now empty.
        // The marker is the authoritative proof of embedded origin.
        sessionType = 'embedded';
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
      const hasPendingPty = this.resumeTracker.hasPtySpawn(cwd) || this.hasPendingResume(cwd);
      const pidChanged = raw.pid > 0 && existingSession!.pid > 0 && raw.pid !== existingSession!.pid;
      const wasClosedNowActive = existingSession!.state === 'closed' && state !== 'closed';
      // Re-evaluate sessionType if the PID changed (session was resumed in a new process)
      // or if a closed embedded session became active again without a pending PTY spawn.
      const wasEmbeddedSession = existingSession!.sessionType === 'embedded';
      if (!hasPendingPty && (pidChanged || wasClosedNowActive) && wasEmbeddedSession) {
        // Re-check if this process is still Overlord-spawned; if not, correct the label.
        // But never downgrade while a live PTY is still linked — the PTY link is the
        // authoritative signal that this is an embedded session.
        const hasLivePty = resolvedOverlordId ? this.hasLivePtyFn(resolvedOverlordId) : false;
        const stillOverlord = hasLivePty || (raw.pid > 0 && this.isSpawnedByOverlord(raw.pid));
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
    // resolvedOverlordId was computed above for storedName lookup; reuse it.
    const overlordId = resolvedOverlordId ?? this.generateOvrId();
    color = this.sessionColorByOvrId(overlordId);

    // Pin startedAt to the lineage's first-observed value, not just this sid's.
    // Auto-resume / /clear creates a fresh sid for the same lineage; matching
    // only by sessionId loses the link and lets raw.startedAt (= recent boot
    // time) win, which reorders rooms by recency on every restart. Sources, in
    // order: existing in-memory same-sid → in-memory session for resumedFrom →
    // any other in-memory session under this ovrId → persisted OverlordSession.
    const startedAt = (() => {
      if (existingSession?.startedAt) return existingSession.startedAt;
      if (resumedFrom) {
        const fromResumed = this.sessions.get(resumedFrom)?.startedAt;
        if (fromResumed) return fromResumed;
      }
      for (const s of this.sessions.values()) {
        if (s.overlordId === overlordId && s.startedAt) return s.startedAt;
      }
      const recStarted = sessionStore.getByOverlordId(overlordId)?.startedAt;
      return recStarted ?? raw.startedAt;
    })();
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
      // Screen-grid derived, transient/live-only — carry across rebuilds (mirrors needsPermission).
      unknownCommand: existingSession?.unknownCommand,
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
      // Transcript wins; fall back to a live screen-detected question (the transcript
      // lacks pending AskUserQuestion tool_uses until they're answered).
      pendingQuestion: transcript?.pendingQuestion ?? existingSession?.pendingQuestion ?? existingSession?.screenQuestion,
      activeMonitors: transcript?.activeMonitors,
      scheduledWakeupAt: transcript?.scheduledWakeupAt,
      scheduledWakeupReason: transcript?.scheduledWakeupReason,
      backgroundTasks: transcript?.backgroundTasks,
      jiraKeys: mergeJiraKeys(
        existingSession?.jiraKeys ?? sessionStore.getByOverlordId(overlordId)?.jiraKeys,
        transcript?.jiraKeys,
        sessionStore.getByOverlordId(overlordId)?.jiraKeysDismissed,
      ),
      skillsUsed: mergeSkillsUsed(
        existingSession?.skillsUsed ?? sessionStore.getByOverlordId(overlordId)?.skillsUsed,
        transcript?.skillsUsed,
      ),
      acknowledged: state === 'waiting' ? (existingSession?.acknowledged ?? (isNew ? loadAck(sessionId) : false)) : false,
      isWorker: raw.kind === 'haiku-worker',
      bridgePipeName: existingSession?.bridgePipeName,
      bridgeMarker: existingSession?.bridgeMarker,
      ptySessionId: existingSession?.ptySessionId,
      transcriptPath: transcriptPath ?? undefined,
      ptyInputPendingSince: this.ptyInputPendingSince.get(sessionId),
    };

    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(overlordId, sessionId);

    // Skip ovr-record persistence for phantom sessions — Claude sometimes
    // writes a transient `~/.claude/sessions/{pid}.json` for an internal
    // sub-step (e.g. file-history snapshot) that exits before any transcript
    // is created. Without this guard, sessionWatcher mints a permanent
    // `ovr-XXX.json` for every such ghost (no name, no messages, never
    // resumable). Persist only when there's evidence of a real session:
    // a transcript file, an existing record, or the process is still alive.
    const isPhantom =
      isNew
      && !transcriptPath
      && !sessionStore.getByOverlordId(overlordId)
      && state === 'closed'
      && !existingSession;
    if (!isPhantom) {
      sessionStore.ensureFromLive(session);
    }

    // When a resume inherits the parent's ovrId, mark the parent session as replaced
    // so it no longer appears as an active / stale entry in the UI (mirrors /clear behaviour).
    if (isNew && resumedFrom && resumedFrom !== sessionId) {
      const parentSession = this.sessions.get(resumedFrom);
      if (parentSession && parentSession.overlordId === overlordId && !parentSession.replacedBy) {
        parentSession.replacedBy = sessionId;
        sessionStore.patch(overlordId, { replacedBy: sessionId });
      }
    }

    // Persist plans via artifactStore — dedupes on claudePlanToolUseId so repeated
    // readTranscriptState calls are idempotent. Always kind='plan'.
    if (transcript?.detectedPlans && transcript.detectedPlans.length > 0) {
      for (const p of transcript.detectedPlans) {
        artifactStore.upsertFromClaude({
          overlordId,
          cwd,
          claudePlanToolUseId: p.planToolUseId,
          body: p.plan,
          status: planStatusFromClaude(p.planStatus),
          title: derivePlanTitle(p.plan),
        });
      }
    }

    this.onChange();
    return { isNewWaiting: isNew && state === 'waiting', lastMessage: transcript?.lastMessage };
  }

  remove(sessionId: string): void {
    this.clearLifecycle.completeReplacement(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const ovrId = existing.overlordId;
      // Only remove from sessionsByOvrId if this session is still the active one for this ovrId
      if (ovrId && this.sessionsByOvrId.get(ovrId) === sessionId) {
        this.sessionsByOvrId.delete(ovrId);
      }
      this.sessions.delete(sessionId);
      clearSessionCaches(sessionId, existing.transcriptPath, existing.cwd);
      this.onChange();
    }
  }

  /** Sweep every in-memory Session sharing this ovrId. transferSessionState
   *  (compaction / resume sid changes) leaves the predecessor in this.sessions
   *  with replacedBy set so the snapshot hides it. If the successor is later
   *  deleted, that hidden predecessor re-surfaces as a closed orphan. Returns
   *  the list of sids that were purged. */
  purgeOvrId(ovrId: string): string[] {
    if (!ovrId) return [];
    const sids: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.overlordId === ovrId) sids.push(s.sessionId);
    }
    for (const sid of sids) {
      this.markDeleted(sid);
      this.remove(sid);
    }
    return sids;
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
    this.clearLifecycle.completeReplacement(sessionId);
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
      if (session.overlordId) {
        sessionStore.patch(session.overlordId, { sessionType: type });
      }
      this.onChange();
    }
  }

  /**
   * Revive a bridge session that was hydrated as 'closed' from sessionStore on restart.
   * Called when the bridge pipe successfully reconnects — the process is still alive,
   * so we re-open the session to 'idle' and let transcriptWatcher/processChecker take over.
   */
  reviveClosedSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state === 'closed') {
      session.state = 'waiting';
      // While closed, the 3s poll and refreshTranscript both early-return
      // (state === 'closed'), so the conversation feed froze at its pre-close
      // state. Force a re-read now that we're 'waiting' so the Conversation tab
      // catches up to the live transcript immediately instead of staying out of
      // sync with the PTY until the next user turn lands.
      this.refreshTranscript(sessionId);
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
    // If newSession already has an overlordId (e.g. it was hydrated from sessionStore at startup),
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
    // Persist durable fields onto the (possibly shared) overlord record. The
    // old and new sessions normally share inheritedOvrId, so a single patch
    // captures bridge metadata + replacedBy. If they don't share an ovrId
    // (oldSession had its own), patch oldSession's overlord too to clear bridge.
    sessionStore.patch(inheritedOvrId, {
      bridgePipeName: newSession.bridgePipeName,
      bridgeMarker: newSession.bridgeMarker,
      sessionType: newSession.sessionType,
      resumedFrom: newSession.resumedFrom,
    });
    if (oldSession.overlordId && oldSession.overlordId !== inheritedOvrId) {
      sessionStore.patch(oldSession.overlordId, {
        replacedBy: newSessionId,
        bridgePipeName: undefined,
        bridgeMarker: undefined,
      });
    }
    this.saveBridgeRegistry();
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
    if (this.isDeleted(candidateSid)) return false;
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
    sessionStore.patch(ovrId, {
      replacedBy: undefined,
      bridgePipeName: target.bridgePipeName,
      bridgeMarker: target.bridgeMarker,
      sessionType: target.sessionType,
    });
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
    if (session.overlordId) {
      const patch: Partial<OverlordSession> = { bridgePipeName: pipeName };
      if (marker !== undefined) patch.bridgeMarker = marker;
      sessionStore.patch(session.overlordId, patch);
    }
    this.saveBridgeRegistry();
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
      if (this.isDeleted(session.sessionId)) continue;
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
    if (this.clearLifecycle.isInFlight(sessionId)) {
      if (result.transcriptTruncated) {
        this.clearLifecycle.completeReplacement(sessionId);
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
      session.acknowledged = false;
      saveAck(sessionId, false);
      session.jiraKeys = undefined;
      session.skillsUsed = undefined;
      if (session.overlordId) sessionStore.patch(session.overlordId, { jiraKeys: undefined, skillsUsed: undefined });
      log('clear:detected', 'In-place transcript truncation', {
        sessionId,
        sessionName: session.proposedName ?? sessionId.slice(0, 8),
      });
    }

    const dismissedKeys = session.overlordId
      ? sessionStore.getByOverlordId(session.overlordId)?.jiraKeysDismissed
      : undefined;
    const mergedJiraKeys = result.transcriptTruncated
      ? (result.jiraKeys && result.jiraKeys.length > 0
          ? result.jiraKeys.filter(k => !dismissedKeys?.includes(k)).slice(0, JIRA_KEYS_MAX)
          : undefined)
      : mergeJiraKeys(session.jiraKeys, result.jiraKeys, dismissedKeys);
    const mergedSkillsUsed = result.transcriptTruncated
      ? (result.skillsUsed && result.skillsUsed.length > 0 ? result.skillsUsed : undefined)
      : mergeSkillsUsed(session.skillsUsed, result.skillsUsed);

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
      session.scheduledWakeupAt !== result.scheduledWakeupAt ||
      !backgroundTasksEqual(session.backgroundTasks, result.backgroundTasks) ||
      session.slug !== slug ||
      session.proposedName !== proposedName ||
      !shallowArrayEquals(session.jiraKeys, mergedJiraKeys) ||
      !shallowArrayEquals(session.skillsUsed, mergedSkillsUsed) ||
      !shallowArrayEquals(session.subagents, subagents);

    if (changed) {
      if (prevState === 'waiting' && result.state !== 'waiting') {
        // Leaving waiting = a real turn started; drop any stale unknown-command bubble.
        session.unknownCommand = undefined;
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
      if (session.model !== result.model) {
        session.model = result.model;
        if (session.overlordId && result.model) {
          sessionStore.patch(session.overlordId, { model: result.model });
        }
      }
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
      session.scheduledWakeupAt = result.scheduledWakeupAt;
      session.scheduledWakeupReason = result.scheduledWakeupReason;
      session.backgroundTasks = result.backgroundTasks;
      if (session.slug !== slug) {
        session.slug = slug;
        if (session.overlordId && slug) {
          sessionStore.patch(session.overlordId, { slug });
        }
      }
      if (session.proposedName !== proposedName) {
        session.proposedName = proposedName;
        if (session.overlordId) {
          sessionStore.patch(session.overlordId, { proposedName });
        }
      }
      // Apply title sentinel AFTER proposedName reconciliation — otherwise the
      // reconcile step above would clobber the sentinel rename using the stale
      // `proposedName` local captured before the sentinel ran.
      this.applyTitleSentinelIfPresent(sessionId, result.lastMessage);
      session.subagents = subagents;
      session.transcriptPath = transcriptPath;
      if (!shallowArrayEquals(session.jiraKeys, mergedJiraKeys)) {
        session.jiraKeys = mergedJiraKeys;
        if (session.overlordId) sessionStore.patch(session.overlordId, { jiraKeys: mergedJiraKeys });
      }
      if (!shallowArrayEquals(session.skillsUsed, mergedSkillsUsed)) {
        session.skillsUsed = mergedSkillsUsed;
        if (session.overlordId) sessionStore.patch(session.overlordId, { skillsUsed: mergedSkillsUsed });
      }
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

  /** User clicked × on a Jira chip. Drop it from live + persisted jiraKeys and
   *  remember it under jiraKeysDismissed so the next transcript scan can't
   *  re-add it via mergeJiraKeys. Idempotent. */
  dismissJiraKey(sessionId: string, key: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.overlordId) return false;
    const rec = sessionStore.getByOverlordId(session.overlordId);
    if (!rec) return false;
    const nextKeys = (session.jiraKeys ?? []).filter(k => k !== key);
    const prevDismissed = rec.jiraKeysDismissed ?? [];
    const nextDismissed = prevDismissed.includes(key)
      ? prevDismissed
      : [key, ...prevDismissed].slice(0, JIRA_DISMISSED_MAX);
    session.jiraKeys = nextKeys.length > 0 ? nextKeys : undefined;
    sessionStore.patch(session.overlordId, {
      jiraKeys: nextKeys.length > 0 ? nextKeys : undefined,
      jiraKeysDismissed: nextDismissed,
    });
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

  /** Record an "Unknown command: /x" the PTY stream detector saw. Screen-grid derived,
   *  never in the transcript. Transient/live-only (not persisted). Cleared by the next
   *  real activity (worker goes active, transcript advances, or /clear). Accepts a Claude
   *  sessionId or an ovrId — the PTY path only knows ovrId. */
  setUnknownCommand(sessionId: string, cmd: string): void {
    const claudeId = this.toClaudeId(sessionId);
    const session = this.sessions.get(claudeId);
    if (!session) return;
    if (session.unknownCommand === cmd) return;
    session.unknownCommand = cmd;
    this.onChange();
  }

  /** Clear the unknown-command bubble once the worker does something real. */
  private clearUnknownCommand(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.unknownCommand === undefined) return;
    session.unknownCommand = undefined;
    this.onChange();
  }

  /** Set/clear a pending AskUserQuestion detected from the live PTY screen.
   *  Stored separately from transcript-derived pendingQuestion (which refreshTranscript
   *  overwrites every tick); surfaced as the pendingQuestion fallback in getSnapshot. */
  setScreenQuestion(sessionId: string, question: PendingQuestionSet | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const prev = session.screenQuestion;
    if (question) {
      // Only fire onChange when the question text actually changes (avoid churn).
      const changed = !prev || JSON.stringify(prev) !== JSON.stringify(question);
      session.screenQuestion = question;
      if (changed) this.onChange();
    } else if (prev) {
      session.screenQuestion = undefined;
      this.onChange();
    }
  }

  /** Called when /clear is injected. Immediately wipes the activity feed and blocks
   *  refreshTranscript from re-reading the old transcript until replacement is detected. */
  clearActivityFeed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearLifecycle.markCleared(sessionId);
    session.activityFeed = [];
    session.pendingQuestion = undefined;
    session.lastMessage = undefined;
    session.unknownCommand = undefined;
    this.onChange();
  }

  markPendingClearReplacement(sessionId: string, cwd: string): void {
    this.clearLifecycle.markPendingReplacement(sessionId, cwd);
  }

  consumePendingClearReplacement(cwd: string): { sessionId: string } | null {
    return this.clearLifecycle.consumePendingReplacement(cwd);
  }

  /** @deprecated No-op. Request summaries superseded by Task.title. */
  setRequestSummary(_sessionId: string, _summary: string): void { /* no-op */ }

  /** Sets the rolling intent summary for a session and broadcasts the update. */
  setIntent(sessionId: string, intent: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.intent === intent) return;
    session.intent = intent;
    if (session.overlordId) sessionStore.patch(session.overlordId, { intent });
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
      // The worker started doing real work — supersede any stale unknown-command bubble.
      this.clearUnknownCommand(claudeId);
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
   * Delete on-disk overlord-session records whose underlying Claude transcripts
   * are either missing or untouched for longer than `maxAgeMs`.
   *
   * Uses transcript mtime as the freshness signal (OverlordSession.lastActivity
   * is only seeded once and drifts). Skips records that are currently hydrated
   * in memory; archived records are never touched (listActive excludes them).
   */
  purgeStaleOverlordSessionFiles(maxAgeMs = 2 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const liveOvrIds = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.overlordId) liveOvrIds.add(s.overlordId);
    }
    const cutoff = now - maxAgeMs;
    let removed = 0;
    for (const rec of sessionStore.listActive()) {
      if (liveOvrIds.has(rec.overlordId)) continue;
      let newest = -Infinity;
      for (const h of rec.lineage?.history ?? []) {
        const tp = h.transcriptPath ?? findTranscriptPath(rec.cwd, h.sessionId) ?? findTranscriptPathAnywhere(h.sessionId);
        if (!tp) continue;
        try {
          const st = fs.statSync(tp);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* missing transcript — counts as unknown */ }
      }
      // No surviving transcript OR newest transcript older than cutoff → delete.
      if (newest === -Infinity || newest < cutoff) {
        sessionStore.remove(rec.overlordId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Periodic GC: remove internal haiku-worker sessions (pid=0, cwd inside ~/.claude).
   * Closed user sessions are intentionally NOT evicted here — they remain in
   * `this.sessions` so their rooms stay visible. On-disk records are pruned
   * separately by `purgeStaleOverlordSessionFiles` (2-day horizon).
   */
  cleanupStaleSessions(): void {
    let anyChanged = false;
    for (const [sessionId, session] of this.sessions) {
      // Remove haiku/internal worker sessions — they have pid=0 and cwd inside ~/.claude
      const cwdNorm = session.cwd.toLowerCase().replace(/\\/g, '/');
      if (cwdNorm.includes('/.claude/') && session.pid === 0) {
        clearSessionCaches(sessionId, session.transcriptPath, session.cwd);
        this.sessions.delete(sessionId);
        anyChanged = true;
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
    // No-op: sessions stay tracked in sessionStore as closed; markDeleted()
    // handles explicit removal when the user deletes a session.
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
    const _t0 = Date.now();
    const roomMap = new Map<string, Room>();
    // Per-snapshot memo (Tier 1 + Tier 2 from snapshot-cost plan): build the
    // plan index ONCE per tick instead of running artifactStore.listByOverlord
    // per session. With N=20+ sessions and 50+ plan artifacts this drops the
    // hot-path cost from O(N×M) to O(M+N).
    const plansByOvr = this.buildPlansByOvr();
    const _t1 = Date.now();

    // Dedupe by overlordId — keep only the entry whose sid matches the
    // store's `lineage.currentSessionId`. After a resume the in-memory map
    // can hold both the old sid (closed) and the new sid (waiting) for the
    // same ovr; rendering both produces duplicate room cards.
    //
    // Also derive replacedOvrIds in the same walk: an ovr record can carry
    // `replacedBy` while its in-memory Session.replacedBy is undefined (the
    // `addOrUpdate` literal at :760 rebuilds Session without preserving
    // persistent fields). The raw-map filter at line below would let that
    // record through; the Set check catches it. Self-referential replacedBy
    // is a known stale-state pattern (see composeSession :2238) — ignore.
    const liveSidByOvr = new Map<string, string>();
    const replacedOvrIds = new Set<string>();
    for (const rec of sessionStore.listActive()) {
      if (rec.lineage?.currentSessionId) liveSidByOvr.set(rec.overlordId, rec.lineage.currentSessionId);
      if (rec.replacedBy && rec.replacedBy !== rec.lineage?.currentSessionId) {
        replacedOvrIds.add(rec.overlordId);
      }
    }
    for (const session of this.sessions.values()) {
      if (session.replacedBy) continue;
      if (session.overlordId && replacedOvrIds.has(session.overlordId)) continue;
      const liveSid = session.overlordId ? liveSidByOvr.get(session.overlordId) : undefined;
      if (liveSid && liveSid !== session.sessionId) continue;
      // Color is lineage-scoped; `setSessionColor` updates every live session
      // in the lineage at write time. No re-derivation needed here.
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
      roomMap.get(cwd)!.sessions.push(this.composeSession(session, plansByOvr));
    }
    const _t2 = Date.now();

    // Surface every configured room even if it currently has no hydrated
    // sessions — the user should always see a room they own so they can spawn
    // a fresh session in it. We reverse-map slug → cwd via sessionStore (the
    // slug alone is lossy, but any OverlordSession that ever lived in the room
    // carries the original cwd).
    const configuredSlugs = new Set(listConfiguredRoomSlugs());
    if (configuredSlugs.size > 0) {
      const presentSlugs = new Set<string>();
      for (const cwd of roomMap.keys()) presentSlugs.add(slugForCwd(cwd));
      const missingSlugs = [...configuredSlugs].filter(s => !presentSlugs.has(s));
      if (missingSlugs.length > 0) {
        const slugToCwd = new Map<string, string>();
        for (const rec of sessionStore.listAll()) {
          const s = slugForCwd(rec.cwd);
          if (!slugToCwd.has(s)) slugToCwd.set(s, rec.cwd);
        }
        for (const slug of missingSlugs) {
          const cwd = slugToCwd.get(slug);
          if (!cwd || roomMap.has(cwd)) continue;
          roomMap.set(cwd, {
            id: cwd.replace(/[\\:/]/g, '-').replace(/^-+/, ''),
            name: path.basename(cwd) || cwd,
            cwd,
            sessions: [],
          });
        }
      }
    }

    const rooms = Array.from(roomMap.values());

    rooms.sort((a, b) => a.name.localeCompare(b.name));

    // Sort sessions within each room by startedAt
    for (const room of rooms) {
      room.sessions.sort((a, b) => a.startedAt - b.startedAt);
    }

    // Attach git branch + PR per room cwd. Per-session attribution is
    // intentionally NOT done here: branches/PRs live at the room level only.
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
    const _t3 = Date.now();

    if (_t3 - _t0 > 100) {
      console.log(`[perf] getSnapshot stages: plansByOvr=${_t1 - _t0}ms compose=${_t2 - _t1}ms gitAttrib=${_t3 - _t2}ms total=${_t3 - _t0}ms sessions=${rooms.reduce((a, r) => a + r.sessions.length, 0)}`);
    }
    // Value = "hot": at least one live (non-closed) session references the key.
    // Hot keys with a still-moving status refresh on a 5m TTL instead of 1h.
    const allKeys = new Map<string, boolean>();
    for (const room of rooms) {
      for (const s of room.sessions) {
        if (!s.jiraKeys) continue;
        const live = s.state !== 'closed';
        for (const k of s.jiraKeys) allKeys.set(k, (allKeys.get(k) ?? false) || live);
      }
    }
    let jiraMeta: Record<string, JiraIssueMeta> | undefined;
    if (allKeys.size > 0) {
      const out: Record<string, JiraIssueMeta> = {};
      for (const [k, hot] of allKeys) {
        const m = getCachedJiraMeta(k, hot);
        if (m && (m.title || m.type || m.status)) out[k] = m;
      }
      if (Object.keys(out).length > 0) jiraMeta = out;
    }

    const settings = globalSettingsStore.get();
    return {
      rooms,
      updatedAt: new Date().toISOString(),
      bridgePath: this.bridgePath,
      platform: process.platform,
      settings: {
        ...settings,
        // Never expose the raw token to clients — same redaction as /api/settings.
        jiraApiToken: settings.jiraApiToken ? '***' : '',
      },
      jiraMeta,
    };
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** True iff this Session is replaced — either via its own in-memory flag OR
   *  via a non-self-referential `replacedBy` on its ovr record. The raw-map
   *  flag drifts (the addOrUpdate literal at :760 rebuilds Session without
   *  preserving persistent fields), so callers outside getSnapshot's hot
   *  path consult sessionStore as the canonical signal. One hashmap probe
   *  per call — fine for event-driven callers, NOT for per-tick loops. */
  private isReplacedOvr(s: Session): boolean {
    if (s.replacedBy) return true;
    if (!s.overlordId) return false;
    const rec = sessionStore.getByOverlordId(s.overlordId);
    return !!rec?.replacedBy && rec.replacedBy !== s.sessionId;
  }

  /** Live, non-replaced sessions. Cheap iterator for hot paths that previously
   *  built the full snapshot just to walk sessions (e.g. find-by-pid, clone-name
   *  uniqueness scan). No sessionStore projection / git / plan I/O. */
  listLiveSessions(): Session[] {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      if (this.isReplacedOvr(s)) continue;
      out.push(s);
    }
    return out;
  }

  /** Find the first live session matching a pid. O(N) over live sessions but
   *  N is small and there is no per-session I/O. Replaces snapshot walks in
   *  `terminal:kill` etc. */
  findLiveSessionByPid(pid: number): Session | undefined {
    for (const s of this.sessions.values()) {
      if (this.isReplacedOvr(s)) continue;
      if (s.pid === pid) return s;
    }
    return undefined;
  }

  /** Drift-proof projected proposedName for a single session — sessionStore
   *  wins over live, mirroring `composeSession`. Used by hot paths that need
   *  the wire-format name without rebuilding the snapshot. */
  getProjectedProposedName(session: Session): string | undefined {
    return sessionStore.getByOverlordId(session.overlordId)?.proposedName ?? session.proposedName;
  }

  /** Is this cwd surfaced as a room by `getSnapshot()`? Mirrors the snapshot's
   *  room-discovery logic (live sessions ∪ persisted records ∪ configured
   *  slugs) without building the full snapshot. Used by API endpoints that
   *  gate on "known cwd" to prevent arbitrary path probing. */
  isKnownRoomCwd(cwd: string): boolean {
    for (const s of this.sessions.values()) {
      if (this.isReplacedOvr(s)) continue;
      if (s.cwd === cwd) return true;
    }
    for (const rec of sessionStore.listAll()) {
      if (rec.cwd === cwd) return true;
    }
    const slug = slugForCwd(cwd);
    return listConfiguredRoomSlugs().includes(slug);
  }

  /** Per-snapshot plan index. Built once at the top of `getSnapshot()` and passed
   *  to `composeSession()` so each session lookup is O(1) instead of running an
   *  artifactStore scan per session. Pulled from `composeSession` rather than
   *  computing inline so other in-process consumers can build the wire-format
   *  Session shape without re-running the projection logic. */
  /** Plan METADATA only — `body` is deliberately excluded. Plan bodies dominated the
   *  snapshot (154KB of 350KB, most of it on closed sessions nobody was viewing) and
   *  were re-serialized at 5Hz to every client. The client fetches the body on demand
   *  via GET /api/artifacts/:artifactId when a plan pill is opened. */
  private buildPlansByOvr(): Map<string, PlanSummary> {
    const out = new Map<string, PlanSummary>();
    for (const a of artifactStore.list('plan')) {
      if (a.status === 'archived') continue;
      const cur = out.get(a.overlordId);
      if (!cur || a.updatedAt.localeCompare(cur.updatedAt) > 0) {
        out.set(a.overlordId, {
          artifactId: a.artifactId,
          title: a.title,
          status: a.status,
          claudePlanToolUseId: a.claudePlanToolUseId,
          updatedAt: a.updatedAt,
        });
      }
    }
    return out;
  }

  /** Single projector for the wire-format `Session`. **Authoritative reader of
   *  persistent fields from sessionStore** — overrides live copies so client
   *  snapshots are drift-proof regardless of what live carries. Live can still
   *  have stale persistent fields (writers haven't all migrated yet), but
   *  clients see the truth from disk.
   *
   *  Persistent fields routed through sessionStore: proposedName, color, slug,
   *  model, intent, sessionType, provider, providerSessionId,
   *  resumedFrom, replacedBy, bridgePipeName, bridgeMarker, historyOnly,
   *  acknowledged. (lastActivity / lastMessage stay live — transcript-derived.)
   *
   *  Also folds in latestPlan (per-snapshot memo), PTY-liveness, and trims
   *  activityFeed to the tail visible without scrolling. */
  private composeSession(
    session: Session,
    plansByOvr: Map<string, PlanSummary>,
  ): Session {
    const overlord = sessionStore.getByOverlordId(session.overlordId);
    const latestPlan = plansByOvr.get(session.overlordId);
    const needsPty = session.sessionType === 'embedded' && session.overlordId;
    const dropFeed = session.state === 'closed';
    const trimmedFeed = dropFeed ? undefined : trimActivityFeed(session.activityFeed);
    const trimmedSubs = trimSubagentFeeds(session.subagents);
    const feedChanged = trimmedFeed !== session.activityFeed;
    const subsChanged = trimmedSubs !== session.subagents;

    const out: Session = { ...session };
    if (overlord) {
      // Persistent fields: sessionStore wins. Use coalescing so a missing
      // overlord field doesn't wipe a live fallback (e.g. transient hydration
      // gaps between addOrUpdate and the first sessionStore.patch).
      out.proposedName = overlord.proposedName ?? session.proposedName;
      out.color = overlord.color ?? session.color;
      out.icon = overlord.icon ?? session.icon;
      out.slug = overlord.slug ?? session.slug;
      out.model = overlord.model ?? session.model;
      out.intent = overlord.intent ?? session.intent;
      out.sessionType = overlord.sessionType ?? session.sessionType;
      out.provider = overlord.provider ?? session.provider;
      out.providerSessionId = overlord.providerSessionId ?? session.providerSessionId;
      out.resumedFrom = overlord.resumedFrom ?? session.resumedFrom;
      // Strip self-referential replacedBy (record claims it was replaced by
      // itself — a stale write from an old transferSessionState). Otherwise
      // getSnapshot's `if (replacedBy) continue` permanently hides the session.
      const candidateReplacedBy = overlord.replacedBy ?? session.replacedBy;
      out.replacedBy = candidateReplacedBy === session.sessionId ? undefined : candidateReplacedBy;
      out.bridgePipeName = overlord.bridgePipeName ?? session.bridgePipeName;
      out.bridgeMarker = overlord.bridgeMarker ?? session.bridgeMarker;
      out.historyOnly = overlord.historyOnly ?? session.historyOnly;
      out.acknowledged = overlord.acknowledged ?? session.acknowledged;
      out.jiraKeys = overlord.jiraKeys ?? session.jiraKeys;
      out.skillsUsed = overlord.skillsUsed ?? session.skillsUsed;
    }
    if (latestPlan) out.latestPlan = latestPlan;
    if (needsPty) out.ptyAlive = this.hasLivePtyFn(session.overlordId);
    // The transcript lacks pending AskUserQuestion tool_uses until they're
    // answered (Claude writes the tool_use + answer together), so a live
    // TUI question only exists in screenQuestion (set by permissionChecker).
    // Surface it as pendingQuestion here — addOrUpdate's fallback never
    // re-runs for embedded sessions with no raw record to poll.
    if (!out.pendingQuestion && session.screenQuestion) {
      out.pendingQuestion = session.screenQuestion;
    }
    // Newest user-message timestamp from the UNTRIMMED feed. The client confirms
    // optimistic "queued" echoes against this — deriving it from the 30-item tail
    // fails in long tool-heavy turns where the user message is evicted while its
    // answer stays, leaving the echo stuck after the AskUserQuestion.
    if (session.activityFeed) {
      for (let i = session.activityFeed.length - 1; i >= 0; i--) {
        const item = session.activityFeed[i];
        if (item.role === 'user' && item.timestamp) { out.lastUserMessageTs = item.timestamp; break; }
      }
    }
    if (feedChanged) {
      out.activityFeed = trimmedFeed;
      if (session.activityFeed && (!trimmedFeed || trimmedFeed.length < session.activityFeed.length)) {
        out.feedTruncated = true;
      }
    }
    if (subsChanged && trimmedSubs) out.subagents = trimmedSubs;
    return out;
  }

  /** Exposed so on-demand git-status endpoint can share the single PR cache. */
  getPrCache(): PrCache {
    return this.prCache;
  }

  getPrHistoryStore(): PrHistoryStore {
    return this.prHistoryStore;
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

  /** Iterate over every in-memory Session. Used by external healers (boot
   *  bridge reconnect) that need to scan for sessions in unusual states. */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** Default avatar color for new sessions. */
  private static readonly DEFAULT_COLOR = 'hsl(30, 75%, 55%)';

  /** Look up the color for a session by claudeSessionId. Resolves ovrId internally. */
  sessionColor(sessionId: string): string {
    const ovrId = this.sessions.get(sessionId)?.overlordId;
    return ovrId ? this.sessionColorByOvrId(ovrId) : StateManager.DEFAULT_COLOR;
  }

  /** Look up the color for an ovrId directly — reads the canonical `OverlordSession.color`. */
  sessionColorByOvrId(ovrId: string): string {
    return sessionStore.getByOverlordId(ovrId)?.color ?? StateManager.DEFAULT_COLOR;
  }

  /** Set a custom color for a session (keyed by its ovrId) and persist to OverlordSession. */
  setSessionColor(sessionId: string, color: string): boolean {
    let rec = sessionStore.getBySessionId(sessionId);
    const live = this.sessions.get(sessionId);
    if (!rec && live) rec = sessionStore.ensureFromLive(live);
    if (!rec) return false;
    sessionStore.patch(rec.overlordId, { color });
    // Propagate to every live session sharing this ovrId so snapshots are
    // consistent without waiting for the next re-derivation tick.
    for (const s of this.sessions.values()) {
      if (s.overlordId === rec.overlordId) s.color = color;
    }
    this.onChange();
    return true;
  }

  /** Set the avatar icon for a session (keyed by its ovrId) and persist to
   *  OverlordSession. Pass 'user' to reset — stored as undefined (the default). */
  setSessionIcon(sessionId: string, icon: WorkerIcon): boolean {
    let rec = sessionStore.getBySessionId(sessionId);
    const live = this.sessions.get(sessionId);
    if (!rec && live) rec = sessionStore.ensureFromLive(live);
    if (!rec) return false;
    const next = icon === 'user' ? undefined : icon;
    sessionStore.patch(rec.overlordId, { icon: next });
    for (const s of this.sessions.values()) {
      if (s.overlordId === rec.overlordId) s.icon = next;
    }
    this.onChange();
    return true;
  }

  /**
   * Rename a session. Updates the durable OverlordSession.proposedName and the
   * live Session so the next snapshot carries the new name. Accepts both live
   * and archived sessions — archived records patch through sessionStore only.
   * Pass an empty string to clear the name.
   *
   * sessionStore (OverlordSession) is the durable write path for proposedName.
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

  /** Detect `<<overlord:title>>...<</overlord:title>>` in the latest assistant text
   *  and rename the session. With Step 3 in place (addOrUpdate now reads
   *  proposedName from sessionStore.getByOverlordId before falling back), live
   *  no longer drifts from disk — so a single titleSentinel-text dedupe is
   *  sufficient. */
  private applyTitleSentinelIfPresent(sessionId: string, lastMessage: string | undefined): void {
    if (!lastMessage) return;
    const match = lastMessage.match(/<<overlord:title>>([\s\S]+?)<<\/overlord:title>>/);
    if (!match) return;
    const title = match[1].trim().slice(0, 80);
    if (!title) return;
    const rec = sessionStore.getBySessionId(sessionId);
    if (!rec) return;
    if (rec.titleSentinel === title) return;
    // Preserve a short uppercase prefix the user added to group sessions
    // (e.g. "OV", "PS-B"); only the topic suffix is replaced.
    const prefixMatch = rec.proposedName?.match(/^([A-Z][A-Z0-9-]{0,5})\s+/);
    const nextName = prefixMatch ? `${prefixMatch[1]} ${title}` : title;
    sessionStore.patch(rec.overlordId, { titleSentinel: title, proposedName: nextName });
    const live = this.sessions.get(sessionId);
    if (live) {
      live.proposedName = nextName;
      this.onChange();
    }
    log('info', 'Title set via sentinel', { sessionId, sessionName: nextName });
  }

  /**
   * One-shot migration: if the legacy `data/colors.json` exists, fold every
   * entry into the matching OverlordSession record, then remove the file.
   * Idempotent — safe to run on every boot until the file disappears.
   */
  private migrateLegacyColors(): void {
    try {
      if (!fs.existsSync(this.legacyColorsFile)) return;
      const data = JSON.parse(fs.readFileSync(this.legacyColorsFile, 'utf-8')) as Record<string, string>;
      let merged = 0;
      for (const [ovrId, color] of Object.entries(data)) {
        const rec = sessionStore.getByOverlordId(ovrId);
        if (!rec) continue;
        if (rec.color === color) continue;
        sessionStore.patch(ovrId, { color });
        merged++;
      }
      fs.unlinkSync(this.legacyColorsFile);
      if (merged > 0) console.log(`[migrate] merged ${merged} legacy color overrides into OverlordSession records`);
    } catch (err) {
      console.warn('[migrate] legacy colors.json migration failed:', (err as Error).message);
    }
  }

  /**
   * Re-hydrate a previously archived session back into stateManager.sessions
   * after unarchive. Caller must have already restored the transcript into
   * ~/.claude/projects and moved the sessionStore record back to active.
   *
   * Clears the deleted blocklist entry (archive's deleteSession path added it),
   * loads transcript state, and inserts as 'closed' so it renders in the room.
   */
  /**
   * On boot, load every non-archived OverlordSession into `this.sessions` as a
   * closed worker. Transcripts may be absent — that's fine, the room just gets
   * an idle card and the user can resume or delete it. Skips records on the
   * deleted blocklist.
   */
  private hydrateAllActiveSessions(): void {
    // Backfill shadow links for every known sessionId in every lineage —
    // catches existing installs and re-links anything Claude hasn't yet
    // deleted. ensureShadow is idempotent and silent on missing originals.
    for (const rec of sessionStore.listActive()) {
      for (const h of rec.lineage?.history ?? []) {
        const original = findTranscriptPath(rec.cwd, h.sessionId) ?? findTranscriptPathAnywhere(h.sessionId);
        if (original) ensureShadow(rec.overlordId, h.sessionId, original);
      }
    }
    for (const rec of sessionStore.listActive()) {
      const sid = rec.lineage?.currentSessionId;
      if (!sid) continue;
      if (this.sessions.has(sid)) continue;
      if (this.isDeleted(sid)) continue;
      // Hydrate every active record, even if its transcript can't be resolved.
      // External tools (Claude itself) can delete a `.jsonl` mid-lineage — e.g.
      // after /clear the pre-clear transcript sometimes vanishes. Dropping the
      // record on boot loses linked artifacts (plans, colors, titles) with no
      // recovery path. `rehydrateFromSessionStore` already tolerates a missing
      // transcript — it just omits transcriptState.
      try { this.rehydrateFromSessionStore(sid); } catch { /* swallow — one bad record shouldn't block boot */ }
    }
  }

  private buildSessionStats() {
    const active = sessionStore.listActive();
    const archived = sessionStore.listArchived();

    const rooms: Record<string, { active: number; archived: number; total: number; snapshotBytes: number }> = {};
    for (const rec of active) {
      const name = path.basename(rec.cwd) || rec.cwd;
      rooms[name] ??= { active: 0, archived: 0, total: 0, snapshotBytes: 0 };
      rooms[name].active++;
      rooms[name].total++;
    }
    for (const rec of archived) {
      const name = path.basename(rec.cwd) || rec.cwd;
      rooms[name] ??= { active: 0, archived: 0, total: 0, snapshotBytes: 0 };
      rooms[name].archived++;
      rooms[name].total++;
    }

    // Measure each room's serialized snapshot size
    const snap = this.getSnapshot();
    for (const room of snap.rooms) {
      const name = path.basename(room.cwd) || room.cwd;
      if (rooms[name]) rooms[name].snapshotBytes = Buffer.byteLength(JSON.stringify(room));
    }

    let transcriptsOnDisk = 0;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(projectsDir)) {
      try {
        for (const slug of fs.readdirSync(projectsDir)) {
          const slugDir = path.join(projectsDir, slug);
          try {
            if (!fs.statSync(slugDir).isDirectory()) continue;
            transcriptsOnDisk += fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl')).length;
          } catch { /* skip unreadable dirs */ }
        }
      } catch { /* ignore */ }
    }

    const toKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
    const totalSnapshotSize = toKB(Buffer.byteLength(JSON.stringify(snap)));

    return {
      sessions: {
        total: active.length + archived.length,
        active: active.length,
        archived: archived.length,
        inMemory: this.sessions.size,
      },
      transcriptsOnDisk,
      totalSnapshotSize,
      rooms: Object.fromEntries(
        Object.entries(rooms).sort(([a], [b]) => a.localeCompare(b)).map(([name, { snapshotBytes, ...r }]) => [
          name,
          { ...r, snapshotSize: toKB(snapshotBytes) },
        ])
      ),
    };
  }

  getStats() {
    return this.buildSessionStats();
  }

  private logBootSummary(): void {
    const stats = this.buildSessionStats();
    console.log(
      `[boot] sessions: ${stats.sessions.total} total (${stats.sessions.active} active, ${stats.sessions.archived} archived) | in-memory: ${stats.sessions.inMemory} | transcripts on disk: ${stats.transcriptsOnDisk}`
    );
    const roomLines = Object.entries(stats.rooms)
      .map(([name, c]) => `  ${name}: ${c.total} (${c.active} active, ${c.archived} archived)`);
    if (roomLines.length > 0) console.log('[boot] rooms:\n' + roomLines.join('\n'));
  }

  rehydrateFromSessionStore(sessionId: string): Session | null {
    const rec = sessionStore.getBySessionId(sessionId);
    if (!rec) return null;

    this.undelete(sessionId);

    const transcriptPath = findTranscriptPath(rec.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
    if (transcriptPath) ensureShadow(rec.overlordId, sessionId, transcriptPath);

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
      icon: rec.icon,
      subagents: [],
      resumedFrom: rec.resumedFrom,
      // Drop self-referential replacedBy — a record whose currentSessionId
      // equals its replacedBy is its own successor; honoring it would hide
      // the session from snapshots forever (`getSnapshot` skips replaced).
      replacedBy: rec.replacedBy === sessionId ? undefined : rec.replacedBy,
      bridgePipeName: rec.bridgePipeName,
      bridgeMarker: rec.bridgeMarker,
      transcriptPath: transcriptPath ?? undefined,
      intent: rec.intent,
      jiraKeys: mergeJiraKeys(rec.jiraKeys, transcriptState?.jiraKeys, rec.jiraKeysDismissed),
      acknowledged: rec.acknowledged,
      historyOnly: rec.historyOnly,
      loadedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.sessionsByOvrId.set(rec.overlordId, sessionId);
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

        // Skip sids already owned by some OverlordSession's lineage (current or
        // historical). Without this, a sid that has been resumed past (so it's
        // in `lineage.history` but no longer `currentSessionId`) gets re-minted
        // here as a new ovr — producing duplicate "twin" rooms (repro: OV Cedar).
        if (sessionStore.resolveOverlordId(sessionId)) continue;

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
        if (this.isDeleted(sessionId)) continue;

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
