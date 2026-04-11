export type WorkerState = 'working' | 'thinking' | 'waiting' | 'closed';
export type SessionProvider = 'claude' | 'codex';

export type ActivityItemKind = 'message' | 'tool' | 'thinking' | 'compact';

export interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for Edit tool calls
  newString?: string;            // for Edit tool calls
  isRedacted?: boolean;
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
}

export interface Session {
  sessionId: string;
  provider?: SessionProvider;
  slug?: string;
  proposedName?: string;
  pid: number;
  startedAt: number;
  cwd: string;
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  ptyCompactItems?: ActivityItem[];  // compact items sourced from PTY output, merged into activityFeed
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  ideName?: string;
  sessionType: 'embedded' | 'bridge' | 'plain' | 'ide';
  replacedBy?: string;
  color: string;
  subagents: Subagent[];
  resumedFrom?: string;
  needsPermission?: boolean;
  permissionPromptText?: string;
  isLimitPrompt?: boolean;
  permissionApprovedAt?: number;  // timestamp ms — suppress re-detection for 30s
  permissionMode?: string;
  permissionModeLockedUntil?: number;  // timestamp ms — screen-detected mode, blocks transcript overwrite
  pendingQuestion?: PendingQuestionSet;
  completionHint?: 'done' | 'awaiting';
  completionHintByUser?: boolean;
  manuallyDone?: boolean;
  completionSummaries?: Task[];
  userAccepted?: boolean;
  currentTaskLabel?: string;
  currentTask?: Task;
  /** @deprecated Use Task.title instead. Kept for backwards-compat with aiClassifier. */
  requestSummary?: string;
  isWorker?: boolean;
  staleCount?: number;

  // Bridge connection metadata (populated when sessionType === 'bridge')
  bridgePipeName?: string;   // e.g. "overlord-new-mnqs8m2f" — the named pipe identifier
  bridgeMarker?: string;     // e.g. "brg-mnqs8m2f" — the ___BRG: marker from session name
  bridgeTty?: string;        // e.g. "/dev/ttys003" — TTY of the Terminal.app tab (macOS only)

  // PTY/embedded connection metadata (populated when sessionType === 'embedded')
  ptySessionId?: string;     // e.g. "pty-abc123" — the PTY manager's session ID
  transcriptPath?: string;

  // PTY input tracking — set when user types in the terminal without pressing Enter
  ptyInputPendingSince?: number;  // ms epoch when pending input started; cleared on Enter
}

export interface Room {
  id: string;
  name: string;
  cwd: string;
  sessions: Session[];
}

export interface OfficeSnapshot {
  rooms: Room[];
  updatedAt: string;
  bridgePath?: string;
  platform: string;  // process.platform: 'darwin' | 'win32' | 'linux'
}
