type WorkerState = 'working' | 'waiting' | 'thinking' | 'closed';
type SessionProvider = 'claude' | 'codex' | 'aider' | 'opencode';

/** How a new terminal session should be spawned */
type TerminalSpawnMode = 'embedded' | 'bridge' | 'plain' | 'raw';

type ActivityItemKind = 'message' | 'tool' | 'thinking' | 'compact';

interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for kind='tool' + toolName='Edit' | 'Write' (Write sets '' to mean "new file")
  newString?: string;            // for kind='tool' + toolName='Edit' | 'Write'
  isRedacted?: boolean;          // for kind='thinking'
  contentTruncated?: boolean;    // message text was cut at 32k; full text only in the transcript/pty
  inputJson?: string;            // full tool input as JSON (truncated)
  resultJson?: string;           // tool result content (truncated to 2000 chars)
  isError?: boolean;             // true if tool_result had is_error: true
  durationMs?: number;           // for kind='tool': how long the tool call took
  timestamp?: string;            // ISO timestamp of when this entry occurred
  pending?: boolean;             // optimistic locally-sent message, not yet processed
  compactMeta?: { trigger: string; preTokens: number }; // for kind='compact'
}

interface Subagent {
  agentId: string;
  agentType: string;
  description: string;
  state: WorkerState;
  lastActivity: string;
  activityFeed?: ActivityItem[];
  model?: string;
}

interface PendingQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: PendingQuestionOption[];
}

interface PendingQuestionSet {
  questions: PendingQuestion[];
}

interface ActiveMonitor {
  toolUseId: string;
  target: string;
  startedAt?: string;
  until?: string;
}

/** A `Bash(run_in_background: true)` command still running — the session is idle
 *  on purpose, waiting for the harness re-invoke when it exits. */
export interface BackgroundTask {
  toolUseId: string;
  taskId: string;
  description?: string;
  startedAt?: string;
  outputFile?: string;
  lastOutputAt?: number;
}

interface Task {
  taskId: string;
  sessionId: string;
  sessionName?: string;   // display name of the session at task creation time
  title?: string;
  summary?: string;
  state: 'active' | 'done';
  createdAt: string;
  completedAt?: string;
  accepted?: boolean;
  kind?: 'task' | 'plan'; // undefined = 'task'
  planContent?: string;   // full plan markdown (kind='plan')
  planToolUseId?: string; // dedup key from ExitPlanMode tool_use.id
  planStatus?: 'approved' | 'rejected' | 'pending'; // only for kind='plan'
}

/** Avatar glyph for a worker. undefined = 'user' (default person glyph). */
export type WorkerIcon = 'user' | 'dashboard' | 'ticket' | 'investigate' | 'teach' | 'notes' | 'btw' | 'release';

interface Session {
  sessionId: string;
  overlordId?: string;       // stable identity across /clear and compaction
  sessionHistory?: Array<{ sessionId: string; attachedAt: number }>;  // all Claude UUIDs ever attached
  provider?: SessionProvider;
  providerSessionId?: string;
  slug?: string;
  proposedName?: string;
  pid: number;
  startedAt: number;      // ms epoch
  cwd: string;
  state: WorkerState;
  lastActivity: string;   // ISO timestamp
  lastMessage?: string;   // last assistant message, max 300 chars
  activityFeed?: ActivityItem[];
  feedTruncated?: boolean;
  ideName?: string;
  color: string;          // e.g. "hsl(120, 65%, 55%)"
  icon?: WorkerIcon;      // avatar glyph; undefined = 'user'
  subagents: Subagent[];
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  resumedFrom?: string;
  sessionType?: 'embedded' | 'bridge' | 'plain' | 'ide' | 'raw';
  /** True when sessionType==='embedded' and the server has a live PTY for this ovrId. */
  ptyAlive?: boolean;
  bridgeTty?: string;         // e.g. "/dev/ttys003" — TTY of the Terminal.app tab (macOS only)
  historyOnly?: boolean;      // revived raw-shell session (disk log only, no live PTY)
  bridgeDead?: boolean;       // output pipe exhausted retries — terminal feed is gone
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  /** Slash command Claude Code rejected ("Unknown command: /x"); transient, screen-derived. */
  unknownCommand?: string;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
  activeMonitors?: ActiveMonitor[];
  scheduledWakeupAt?: number;  // epoch ms a pending ScheduleWakeup fires; present ⇒ show "scheduled" instead of "waiting"
  scheduledWakeupReason?: string;  // why it's sleeping (the ScheduleWakeup `reason`)
  backgroundTasks?: BackgroundTask[];  // in-flight background Bash commands; present ⇒ show "running" instead of "waiting"
  jiraKeys?: string[];
  skillsUsed?: string[];         // skill/command names invoked in this session, accumulated server-side
  acknowledged?: boolean;  // user-set: silence the pulsing WAITING bubble
  /** Metadata only — the plan `body` is fetched on demand via GET /api/artifacts/:artifactId. */
  latestPlan?: { artifactId: string; title: string; status: string; claudePlanToolUseId?: string; updatedAt: string; };
  lastUserMessageTs?: string;     // newest user-message ts from untrimmed feed; confirms optimistic echoes past the tail
  intent?: string;                // rolling Haiku-generated summary of what the session is doing
  isWorker?: boolean;
  ptyInputPendingSince?: number;  // ms epoch when pending terminal input started; cleared on Enter
  isArchived?: boolean;           // synthetic flag: session was archived and is being viewed read-only
  archivedAt?: string;            // ISO timestamp of archival (only when isArchived)
  archivedGitBranch?: string;     // snapshot of branch at archive time
  archivedPullRequest?: { number: number; url: string; title: string; state: string; isDraft: boolean };
}

interface Room {
  id: string;
  name: string;           // basename of cwd
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
  gitWarning?: string;
  description?: string;
}

interface ArchiveEntry {
  sessionId: string;
  roomId: string;
  cwd: string;
  name: string;
  archivedAt: string;       // ISO
  pid: number;
  provider?: SessionProvider;
  providerSessionId?: string;
  sessionType?: Session['sessionType'];
  startedAt?: number;
  color?: string;
  gitBranch?: string;
  pullRequest?: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
  };
  lastMessage?: string;
  lastActivity?: string;
  model?: string;
  intent?: string;
  notes?: string;
}

interface GlobalSettings {
  disableBackgroundLLM: boolean;
  autoResumeOnRestart: boolean;
  jiraBaseUrl?: string;
  jiraProjects?: string;
  jiraEmail?: string;
  /** Masked from the server: "" when unset, "***" when set. */
  jiraApiToken?: string;
}

/** Resolved metadata for a single Jira issue key. All fields optional. */
export interface JiraIssueMeta {
  title?: string;          // issue summary
  type?: string;           // issuetype.name: "Bug" | "Story" | "Epic" | "Task" | …
  status?: string;         // status.name: "In Progress" | "Done" | …
  statusCategory?: string; // status.statusCategory.key: "new" | "indeterminate" | "done"
}

interface OfficeSnapshot {
  rooms: Room[];
  updatedAt: string;
  bridgePath?: string;
  platform: string;  // 'darwin' | 'win32' | 'linux'
  settings: GlobalSettings;
  /** Map of Jira key → resolved metadata. Server fills it from jiraTitleCache
   *  when credentials are configured; absent or empty otherwise. */
  jiraMeta?: Record<string, JiraIssueMeta>;
}

// Terminal message types (server → client)
interface TerminalOutputMessage {
  type: 'terminal:output';
  sessionId: string;
  data: string; // base64-encoded
}

interface TerminalSpawnedMessage {
  type: 'terminal:spawned';
  sessionId: string;
  pid: number;
}

interface TerminalExitMessage {
  type: 'terminal:exit';
  sessionId: string;
  code: number;
}

interface TerminalErrorMessage {
  type: 'terminal:error';
  sessionId: string;
  message: string;
}

interface TerminalLinkedMessage {
  type: 'terminal:linked';
  ovrId: string;           // stable overlord session ID (persists across /clear, compaction)
  ptySessionId: string;
  claudeSessionId: string;
  replay?: boolean;
}

interface TerminalClearMessage {
  type: 'terminal:clear';
  sessionId: string;
}

interface TerminalHistoryDumpMessage {
  type: 'terminal:history-dump';
  sessionId: string;
  data: string; // base64-encoded raw output + banner
}

type TerminalMessage =
  | TerminalOutputMessage
  | TerminalSpawnedMessage
  | TerminalExitMessage
  | TerminalErrorMessage
  | TerminalLinkedMessage
  | TerminalClearMessage
  | TerminalHistoryDumpMessage;

// Typed snapshot message (server → client)
interface SnapshotMessage {
  type: 'snapshot';
  rooms: Room[];
  updatedAt: string;
}

// Client → server messages
interface TerminalSpawnRequest {
  type: 'terminal:spawn';
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
  provider?: SessionProvider;
}

interface TerminalInputRequest {
  type: 'terminal:input';
  sessionId: string;
  data: string;
}

interface TerminalInjectRequest {
  type: 'terminal:inject';
  sessionId: string;
  text: string;
}

interface TerminalResizeRequest {
  type: 'terminal:resize';
  sessionId: string;
  cols: number;
  rows: number;
}

// Log event types (server → client)
type LogEventType =
  | 'session:created'
  | 'session:removed'
  | 'session:replaced'
  | 'session:state'
  | 'session:resumed'
  | 'session:killed'
  | 'pty:started'
  | 'pty:linked'
  | 'clear:detected'
  | 'info';

interface LogEntry {
  id: number;
  timestamp: string; // ISO
  event: LogEventType;
  sessionId?: string;
  sessionName?: string;
  detail: string;
  extra?: string;
}

interface LogHistoryMessage {
  type: 'log:history';
  entries: LogEntry[];
}

interface LogEntryMessage {
  type: 'log:entry';
  entry: LogEntry;
}

type ArtifactStatus = 'draft' | 'active' | 'done' | 'archived';
type ArtifactSource = 'claude' | 'user';
type ArtifactKind = 'plan' | 'summary' | 'compact';

interface Artifact {
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: ArtifactStatus;
  source: ArtifactSource;
  claudePlanToolUseId?: string;
  body: string;
}

interface ArtifactChangedEvent {
  type: 'artifact:changed';
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}

const SESSION_PROVIDERS: SessionProvider[] = ['claude', 'codex', 'aider', 'opencode'];
const SPAWNABLE_SESSION_PROVIDERS: SessionProvider[] = ['claude', 'opencode'];

export type {
  WorkerState,
  SessionProvider,
  ActivityItemKind,
  ActivityItem,
  Subagent,
  Task,
  Session,
  PendingQuestion,
  PendingQuestionSet,
  PendingQuestionOption,
  ActiveMonitor,
  Room,
  ArchiveEntry,
  GlobalSettings,
  OfficeSnapshot,
  TerminalMessage,
  TerminalLinkedMessage,
  TerminalClearMessage,
  TerminalSpawnMode,
  SnapshotMessage,
  TerminalSpawnRequest,
  TerminalInputRequest,
  TerminalInjectRequest,
  TerminalResizeRequest,
  LogEventType,
  LogEntry,
  LogHistoryMessage,
  LogEntryMessage,
  Artifact,
  ArtifactKind,
  ArtifactStatus,
  ArtifactSource,
  ArtifactChangedEvent,
  SESSION_PROVIDERS,
  SPAWNABLE_SESSION_PROVIDERS,
};

// ── Session type helpers ──────────────────────────────────

type LaunchCategory = 'pty' | 'bridge' | 'ide' | 'terminal' | 'shell';

interface LaunchInfo {
  category: LaunchCategory;
  /** Display name shown in the badge pill */
  name: string;
}

function getLaunchInfo(
  session: { sessionType?: Session['sessionType']; ideName?: string },
  isPtyActive?: boolean,
): LaunchInfo {
  // Shorten "IntelliJ IDEA" → "IntelliJ", "PyCharm Professional" → "PyCharm", etc.
  const shortIde = (raw: string) =>
    raw.replace(/\s+(IDEA|Community|Ultimate|Professional|Enterprise|Educational|CE)\b.*/, '').trim();

  if (session.sessionType === 'raw') {
    return { category: 'shell', name: 'Shell' };
  }
  if (session.sessionType === 'bridge') {
    const ideLabel = session.ideName ? shortIde(session.ideName) : undefined;
    return { category: 'bridge', name: ideLabel ?? 'Bridge' };
  }
  // Only show "Overlord" if the session was actually spawned by Overlord.
  // isPtyActive alone is not enough — an IDE/terminal session can have a PTY
  // attached without being Overlord-originated.
  if (session.sessionType === 'embedded' || (isPtyActive && !session.sessionType)) {
    return { category: 'pty', name: 'Overlord' };
  }
  if (session.sessionType === 'ide' || session.ideName) {
    const rawName = session.ideName ?? 'IDE';
    return { category: 'ide', name: shortIde(rawName) };
  }
  return { category: 'terminal', name: session.ideName ? `Terminal / ${shortIde(session.ideName)}` : 'Terminal' };
}

export { getLaunchInfo };
export type { LaunchCategory, LaunchInfo };
