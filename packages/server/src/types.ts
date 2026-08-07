export type WorkerState = 'working' | 'thinking' | 'waiting' | 'closed';
// Include 'aider' to support Aider provider sessions (MVP: detection/tracking only, no Overlord spawn).
export type SessionProvider = 'claude' | 'codex' | 'aider' | 'opencode';

export type ActivityItemKind = 'message' | 'tool' | 'thinking' | 'compact' | 'recap';

export interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for Edit tool calls
  newString?: string;            // for Edit tool calls
  isRedacted?: boolean;
  contentTruncated?: boolean;    // content was cut at MAX_MESSAGE_LENGTH; full text only in transcript
  inputJson?: string;            // full tool input as JSON (truncated)
  resultJson?: string;           // tool result content (truncated to 2000 chars)
  isError?: boolean;             // true if tool_result had is_error: true
  durationMs?: number;           // for kind='tool': how long the tool call took
  timestamp?: string;            // ISO timestamp of when this entry occurred
  compactMeta?: { trigger: string; preTokens: number }; // for kind='compact'
}

export interface Subagent {
  agentId: string;
  agentType: string;
  description: string;
  state: WorkerState;
  lastActivity: string;
  activityFeed?: ActivityItem[];
  model?: string;
}

export interface PendingQuestionOption {
  label: string;
  description?: string;
  preview?: string;
  /** True for the options the AskUserQuestion TUI appends itself ("Type something",
   *  "Chat about this"). They are not model-authored, and answering them requires a
   *  follow-up free-text injection rather than a plain Enter. */
  builtin?: boolean;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: PendingQuestionOption[];
}

/** All questions from one AskUserQuestion tool call */
export interface PendingQuestionSet {
  questions: PendingQuestion[];
  /** The assistant text rendered directly above the menu in the TUI. Claude flushes
   *  nothing of an AskUserQuestion turn to the transcript until the question is
   *  answered — text block included — so while the menu is up this is the only
   *  source of the preamble. Screen-derived only; undefined on transcript sets,
   *  where the real assistant message is already in the feed. */
  preamble?: string;
}

/** An in-flight Monitor tool_use — emitted while the tool has no tool_result yet. */
export interface ActiveMonitor {
  toolUseId: string;
  target: string;        // best-effort: input.shellId ?? input.taskId ?? input.id ?? ''
  startedAt?: string;    // ISO timestamp of the tool_use
  until?: string;        // input.until regex, if any
}

/** A `Bash(run_in_background: true)` command that was launched and has not yet
 *  reported a <task-notification>. Present ⇒ the session is idle on purpose:
 *  the harness re-invokes it when the command exits. */
export interface BackgroundTask {
  toolUseId: string;      // Bash tool_use id — join key with <tool-use-id>
  taskId: string;         // shell id, e.g. "bw5hy60h4"
  description?: string;   // Bash `description` input — label for the bubble
  startedAt?: string;     // ISO timestamp of the tool_use
  outputFile?: string;    // …/tasks/<taskId>.output
  lastOutputAt?: number;  // epoch ms — mtime of outputFile, liveness hint
}

export interface Task {
  taskId: string;         // e.g. "{sessionId}-1"
  sessionId: string;
  sessionName?: string;   // display name of the session at task creation time
  title?: string;         // 5–8 word Haiku-generated title
  summary?: string;       // 1-sentence completion summary
  state: 'active' | 'done';
  createdAt: string;      // ISO
  completedAt?: string;   // ISO
  accepted?: boolean;
  kind?: 'task' | 'plan'; // undefined = 'task' (back-compat)
  planContent?: string;   // full plan markdown (kind='plan')
  planToolUseId?: string; // dedup key from ExitPlanMode tool_use.id
  planStatus?: 'approved' | 'rejected' | 'pending'; // only for kind='plan'
}

/** Plan metadata carried in the WS snapshot. The `body` is NOT included — it is
 *  fetched on demand via GET /api/artifacts/:artifactId. See buildPlansByOvr. */
export interface PlanSummary {
  artifactId: string;
  title: string;
  status: string;
  claudePlanToolUseId?: string;
  updatedAt: string;
}

/**
 * Avatar glyphs a worker can wear. Single source of truth — the `WorkerIcon`
 * type is derived from it and every validation site (`PUT /api/sessions/:id/icon`,
 * `POST /api/sessions/spawn`, WS `terminal:spawn`) goes through `isWorkerIcon`,
 * so adding a glyph here is the only server-side edit needed.
 *
 * `packages/client/src/types.ts` keeps a parallel copy (separate package, no
 * cross-package import) — kept honest by the drift test in
 * `session/__tests__/spawnIcon.test.ts`.
 */
export const WORKER_ICONS = ['user', 'dashboard', 'ticket', 'investigate', 'teach', 'notes', 'btw', 'release'] as const;

/** Avatar glyph for a worker. `undefined` means 'user' (default person glyph). */
export type WorkerIcon = typeof WORKER_ICONS[number];

export function isWorkerIcon(value: unknown): value is WorkerIcon {
  return typeof value === 'string' && (WORKER_ICONS as readonly string[]).includes(value);
}

/** User-set review marker on a session. There is deliberately no 'done' — a
 *  session is never "finished" from the office's point of view. */
export type SessionReview = 'read' | 'parked';

export interface Session {
  sessionId: string;
  overlordId: string;   // stable identifier across /clear and compaction; assigned once per lineage
  sessionHistory?: Array<{ sessionId: string; attachedAt: number }>;  // all Claude UUIDs ever attached to this ovrId
  provider?: SessionProvider;   // 'claude' | 'codex' | 'aider' | 'opencode'
  providerSessionId?: string;   // provider-native session ID (eg. OpenCode ses_...)
  slug?: string;
  proposedName?: string;
  pid: number;
  startedAt: number;
  cwd: string;
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  feedTruncated?: boolean;
  /** True when this session has any activity at all. Sent for EVERY session;
   *  `activityFeed` is sent only for the focused one, so cards that used to test
   *  `activityFeed.length > 0` must use this instead. */
  hasActivity?: boolean;
  ptyCompactItems?: ActivityItem[];  // compact items sourced from PTY output, merged into activityFeed
  ptyCompactBaseline?: number;  // compactCount at the moment PTY detected "Compacting conversation"; keeps isCompacting sticky until a new boundary lands
  ptyCompactBaselineAt?: number;  // Date.now() of baseline snapshot; used for TTL safety release
  ptyCompactBoundarySeen?: boolean;  // transcript's isCompacting seen true while baseline held — release when it goes back to false
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  ideName?: string;
  sessionType: 'embedded' | 'bridge' | 'plain' | 'ide' | 'raw';
  replacedBy?: string;
  color: string;
  icon?: WorkerIcon;
  subagents: Subagent[];
  resumedFrom?: string;
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  /** Slash command the user typed that Claude Code rejected ("Unknown command: /x").
   *  Screen-grid derived (never in the transcript); transient/live-only, not persisted.
   *  Cleared on the next real activity. */
  unknownCommand?: string;
  permissionApprovedAt?: number;  // timestamp ms — suppress re-detection for 30s
  permissionMode?: string;
  permissionModeLockedUntil?: number;  // timestamp ms — screen-detected mode, blocks transcript overwrite
  pendingQuestion?: PendingQuestionSet;
  // A pending AskUserQuestion detected from the live PTY screen (not the transcript —
  // Claude only writes the tool_use to the transcript after it's answered). Used as the
  // pendingQuestion fallback so a live TUI question still surfaces in the UI.
  screenQuestion?: PendingQuestionSet;
  /** True ⇒ we can read this session's screen and it is NOT showing an AskUserQuestion
   *  menu. A transcript-derived pendingQuestion is then stale: the TUI already moved on
   *  (answered elsewhere, declined, Esc), so injecting arrows/Enter would land on the
   *  ordinary composer and do nothing. Undefined ⇒ no screen evidence either way. */
  screenQuestionAbsent?: boolean;
  /** Snapshot-only: pendingQuestion is transcript-derived but the live screen shows
   *  no menu — render it read-only; clicking an option cannot reach the TUI. */
  questionStale?: boolean;
  activeMonitors?: ActiveMonitor[];
  /** Epoch ms when a pending ScheduleWakeup fires. Present ⇒ the session is
   *  idle on purpose (dynamic /loop pacing) — UI shows "scheduled" instead of
   *  "waiting". Survives user interjections (the wakeup still fires); cleared
   *  by a newer ScheduleWakeup (incl. stop) or expiry (fire time + 30s). */
  scheduledWakeupAt?: number;
  /** The `reason` string of that pending wakeup — one sentence, shown in the UI. */
  scheduledWakeupReason?: string;
  /** In-flight `Bash(run_in_background: true)` commands. Present ⇒ the session is
   *  waiting on the harness re-invoke, not on the user — UI shows "running"
   *  instead of "waiting". Cleared by the matching <task-notification>. */
  backgroundTasks?: BackgroundTask[];
  /** JIRA-shaped ticket keys mined from this session's transcript. Union-merged
   *  across reads — keys seen earlier in the conversation but no longer in the
   *  tail window persist here. Wiped on /clear (transcriptTruncated). */
  jiraKeys?: string[];
  /** Skill/command names invoked in this session (union across transcript reads).
   *  Wiped on /clear (transcriptTruncated). */
  skillsUsed?: string[];
  /** User-set review marker. 'read' silences the pulsing WAITING bubble and
   *  auto-clears on the next turn; 'parked' is deliberate and sticky — it
   *  survives new activity and only an explicit un-park clears it. */
  review?: SessionReview;
  /** Optional free text explaining the park. Only meaningful with review==='parked'. */
  parkReason?: string;
  /** Epoch ms the session was parked — drives the "parked 4h" label. */
  parkedAt?: number;
  latestPlan?: PlanSummary;
  /** ISO timestamp of the newest user message in the UNTRIMMED activity feed.
   *  Client uses it to confirm optimistic echoes even when the real message has
   *  scrolled out of the 30-item snapshot tail. */
  lastUserMessageTs?: string;
  /** Rolling Haiku-generated summary of what the session is working on. Replaces requestSummary and completionSummary on the worker card. */
  intent?: string;
  /** @deprecated Use Task.title instead. Kept for backwards-compat with aiClassifier. */
  requestSummary?: string;
  isWorker?: boolean;
  staleCount?: number;

  // Bridge connection metadata (populated when sessionType === 'bridge')
  bridgePipeName?: string;   // e.g. "overlord-new-mnqs8m2f" — the named pipe identifier
  bridgeMarker?: string;     // e.g. "brg-mnqs8m2f" — the ___BRG: marker from session name
  bridgeTty?: string;        // e.g. "/dev/ttys003" — TTY of the Terminal.app tab (macOS only)
  bridgeDead?: boolean;      // true when output pipe exhausted all retries — terminal feed is gone

  // PTY/embedded connection metadata (populated when sessionType === 'embedded')
  ptySessionId?: string;     // e.g. "pty-abc123" — the PTY manager's session ID
  transcriptPath?: string;
  /** True when sessionType==='embedded' AND a PTY is currently registered for this
   *  ovrId in `ovrToPty`. After a server restart, persisted sessionType stays
   *  'embedded' but no PTY exists — client uses this flag to show "reopen"
   *  instead of a live terminal. */
  ptyAlive?: boolean;

  // Raw shell history-only marker — revived from disk log on startup, no live PTY.
  // User can click "Restart shell" in DetailPanel to spawn a fresh shell at original cwd.
  historyOnly?: boolean;

  // PTY input tracking — set when user types in the terminal without pressing Enter
  ptyInputPendingSince?: number;  // ms epoch when pending input started; cleared on Enter

  // Timestamp when session was added to state (used by GC to avoid premature removal)
  loadedAt?: number;
}

/** One attached Claude session UUID in the overlord's lineage. */
export interface LineageEntry {
  sessionId: string;
  attachedAt: number;
  transcriptPath?: string;
  reason?: 'initial' | 'clear' | 'compact' | 'resume';
}

/** Per-history-entry transcript copy made at archive time. */
export interface ArchivedTranscript {
  sessionId: string;
  /** Path under `~/.claude/overlord/archive/{slug}/{overlordId}/{sid}.jsonl` */
  path: string;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
}

/**
 * Persisted per-overlord entity — one `{overlordId}.json`.
 *   Active:   `~/.claude/overlord/overlord-sessions/{overlordId}.json`
 *   Archived: `~/.claude/overlord/overlord-sessions-archive/{overlordId}.json`
 *
 * Keyed by `overlordId` (stable across /clear and /compact). Each /clear or /compact
 * appends to `lineage.history` and updates `lineage.currentSessionId`.
 *
 * Durable work fields (intent, notes, tasks, review/park) are at the overlord level so
 * they carry through clears; they never reset when a new sessionId attaches.
 *
 * Archived state is signalled two ways that must agree:
 *   1. File lives in `overlord-sessions-archive/` (primary signal — cheap to list)
 *   2. `archive` block is populated (frozen snapshot: roomId, name, gitBranch, PR, transcripts)
 */
export interface OverlordSession {
  overlordId: string;
  cwd: string;
  startedAt: number;
  color: string;
  icon?: WorkerIcon;
  proposedName?: string;

  /** Atomic unit — currentSessionId and history must stay in sync. */
  lineage: {
    currentSessionId: string;
    history: LineageEntry[];
  };

  provider?: SessionProvider; // 'claude' | 'codex' | 'aider' | 'opencode'
  sessionType: 'embedded' | 'bridge' | 'plain' | 'ide' | 'raw';
  providerSessionId?: string;
  model?: string;
  slug?: string;
  resumedFrom?: string;
  replacedBy?: string;
  bridgeMarker?: string;
  bridgePipeName?: string;
  historyOnly?: boolean;

  lastActivity?: string;
  lastMessage?: string;

  /** Body of the most recently applied <<overlord:title>>…<</overlord:title>> sentinel.
   *  Used to dedupe sentinel-driven renames across transcript rereads and restarts:
   *  the apply path is a no-op when the extracted title matches this. */
  titleSentinel?: string;

  intent?: string;
  intentTurnCount?: number;
  intentUpdatedAt?: number;
  notes?: string;
  /** Persisted JIRA-shaped ticket keys (union across transcript reads). Wiped on /clear. */
  jiraKeys?: string[];
  /** Keys the user explicitly dismissed via the chip × button. The transcript
   *  scanner will keep finding them; mergeJiraKeys filters this set out so
   *  dismissed keys don't reappear on the next read. Cap 50, recent-first. */
  jiraKeysDismissed?: string[];
  /** Keys the user added by hand via the `+` button on an inline ticket key in
   *  the conversation feed. Merged ahead of scanned keys and never evicted by
   *  them; exempt from jiraKeysDismissed (pinning is the un-dismiss). Wiped on
   *  /clear. Cap 5. */
  jiraKeysPinned?: string[];
  /** Persisted skill/command names invoked in this session (union across
   *  transcript reads). Wiped on /clear. */
  skillsUsed?: string[];

  /** Pending --resume targeting this lineage from `cwd` started at `at` (epoch ms).
   *  Replaces the legacy ~/.claude/overlord/pending-resumes.json file. Cleared
   *  when consumed in addOrUpdate or invalidated by a fresh PTY spawn. */
  pendingResume?: { cwd: string; at: number };
  currentTask?: Task;
  completionSummaries?: Task[];
  /** @see Session.review — persisted so park/read survive a restart. */
  review?: SessionReview;
  parkReason?: string;
  parkedAt?: number;
  /** @deprecated Superseded by `review`. Read-only: `readReview()` maps a legacy
   *  `true` to 'read'; every write path drops the field. Never write it again. */
  acknowledged?: boolean;

  /** Presence = archived. Written when the record moves to the archive dir. */
  archive?: {
    archivedAt: string;
    roomId: string;
    name: string;
    gitBranch?: string;
    pullRequest?: PullRequestSnapshot;
    transcripts: ArchivedTranscript[];
  };
}

/**
 * Runtime-only session wrapper. Holds ephemeral fields (PTY handles, permissions,
 * bridge connection state, pendingQuestion). Never persisted.
 */
export interface LiveSession {
  overlord: OverlordSession;
  pid: number;
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  subagents: Subagent[];
  ptyCompactItems?: ActivityItem[];
  ptyCompactBaseline?: number;
  ptyCompactBaselineAt?: number;
  ptyCompactBoundarySeen?: boolean;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  ideName?: string;
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  unknownCommand?: string;
  permissionApprovedAt?: number;
  permissionMode?: string;
  permissionModeLockedUntil?: number;
  pendingQuestion?: PendingQuestionSet;
  activeMonitors?: ActiveMonitor[];
  jiraKeys?: string[];
  skillsUsed?: string[];
  providerSessionId?: string;
  requestSummary?: string;
  isWorker?: boolean;
  staleCount?: number;
  bridgeTty?: string;
  bridgeDead?: boolean;
  ptySessionId?: string;
  ptyInputPendingSince?: number;
  loadedAt?: number;
}

export interface Room {
  id: string;
  name: string;
  cwd: string;
  sessions: Session[];
  gitBranch?: string;
  gitAhead?: number;
  pullRequest?: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
  };
  gitWarning?: string;  // present when gh/git pr lookup failed
  description?: string;  // free-form per-room notes; first line renders in header
  hidden?: boolean;  // persisted room-config hidden flag; client union-seeds its local store from it
}

export interface GlobalSettings {
  disableBackgroundLLM: boolean;
  autoResumeOnRestart: boolean;
  showStickyUserMessage: boolean;
  jiraBaseUrl?: string;
  jiraProjects?: string;
  jiraEmail?: string;
  /** Token is server-internal; the /api/settings GET response returns the
   *  literal "***" when set or "" when unset (never the raw value). */
  jiraApiToken?: string;
}

/** Resolved metadata for a single Jira issue key. All fields optional — a key
 *  may resolve a summary but not a type/status, or vice-versa. */
export interface JiraIssueMeta {
  title?: string;          // issue summary
  type?: string;           // issuetype.name: "Bug" | "Story" | "Epic" | "Task" | …
  status?: string;         // status.name: "In Progress" | "Done" | …
  statusCategory?: string; // status.statusCategory.key: "new" | "indeterminate" | "done"
}

export interface OfficeSnapshot {
  rooms: Room[];
  updatedAt: string;
  bridgePath?: string;
  platform: string;  // process.platform: 'darwin' | 'win32' | 'linux'
  settings: GlobalSettings;
  /** Map of Jira issue key → resolved metadata. Built from jiraTitleCache; only
   *  contains entries the server has successfully resolved. Missing keys → chip
   *  falls back to "Open KEY in JIRA". */
  jiraMeta?: Record<string, JiraIssueMeta>;
}
