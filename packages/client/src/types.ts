type WorkerState = 'working' | 'waiting' | 'thinking' | 'closed';
type SessionProvider = 'claude' | 'codex';

/** How a new terminal session should be spawned */
type TerminalSpawnMode = 'embedded' | 'bridge' | 'plain';

type ActivityItemKind = 'message' | 'tool' | 'thinking' | 'compact';

interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for kind='tool' + toolName='Edit'
  newString?: string;            // for kind='tool' + toolName='Edit'
  isRedacted?: boolean;          // for kind='thinking'
  inputJson?: string;            // full tool input as JSON (truncated)
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
}

interface Session {
  sessionId: string;
  provider?: SessionProvider;
  slug?: string;
  proposedName?: string;
  pid: number;
  startedAt: number;      // ms epoch
  cwd: string;
  state: WorkerState;
  lastActivity: string;   // ISO timestamp
  lastMessage?: string;   // last assistant message, max 300 chars
  activityFeed?: ActivityItem[];
  ideName?: string;
  color: string;          // e.g. "hsl(120, 65%, 55%)"
  subagents: Subagent[];
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  resumedFrom?: string;
  sessionType?: 'embedded' | 'bridge' | 'plain' | 'ide';
  bridgeTty?: string;         // e.g. "/dev/ttys003" — TTY of the Terminal.app tab (macOS only)
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  permissionMode?: string;
  pendingQuestion?: PendingQuestionSet;
  completionHint?: 'done' | 'awaiting';
  completionSummaries?: Task[];
  userAccepted?: boolean;
  currentTaskLabel?: string;
  currentTask?: Task;
  isWorker?: boolean;
  ptyInputPendingSince?: number;  // ms epoch when pending terminal input started; cleared on Enter
}

interface Room {
  id: string;
  name: string;           // basename of cwd
  cwd: string;
  sessions: Session[];
}

interface OfficeSnapshot {
  rooms: Room[];
  updatedAt: string;
  bridgePath?: string;
  platform: string;  // 'darwin' | 'win32' | 'linux'
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
  ptySessionId: string;
  claudeSessionId: string;
}

interface TerminalSessionReplacedMessage {
  type: 'terminal:session-replaced';
  oldSessionId: string;
  newSessionId: string;
}

interface TerminalClearMessage {
  type: 'terminal:clear';
  sessionId: string;
}

type TerminalMessage =
  | TerminalOutputMessage
  | TerminalSpawnedMessage
  | TerminalExitMessage
  | TerminalErrorMessage
  | TerminalLinkedMessage
  | TerminalSessionReplacedMessage
  | TerminalClearMessage;

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
  Room,
  OfficeSnapshot,
  TerminalMessage,
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
};

// ── Session type helpers ──────────────────────────────────

type LaunchCategory = 'pty' | 'bridge' | 'ide' | 'terminal';

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

  if (session.sessionType === 'bridge') {
    const suffix = session.ideName ? ` / ${shortIde(session.ideName)}` : '';
    return { category: 'bridge', name: `Bridge${suffix}` };
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
