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
  kind?: 'task' | 'plan'; // undefined = 'task' (back-compat)
  planContent?: string;   // full plan markdown (kind='plan')
  planToolUseId?: string; // dedup key from ExitPlanMode tool_use.id
  planStatus?: 'approved' | 'rejected' | 'pending'; // only for kind='plan'
}

export interface Session {
  sessionId: string;
  overlordId: string;   // stable identifier across /clear and compaction; assigned once per lineage
  sessionHistory?: Array<{ sessionId: string; attachedAt: number }>;  // all Claude UUIDs ever attached to this ovrId
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
  bridgeDead?: boolean;      // true when output pipe exhausted all retries — terminal feed is gone

  // PTY/embedded connection metadata (populated when sessionType === 'embedded')
  ptySessionId?: string;     // e.g. "pty-abc123" — the PTY manager's session ID
  transcriptPath?: string;

  // Raw shell history-only marker — revived from disk log on startup, no live PTY.
  // User can click "Restart shell" in DetailPanel to spawn a fresh shell at original cwd.
  historyOnly?: boolean;

  // PTY input tracking — set when user types in the terminal without pressing Enter
  ptyInputPendingSince?: number;  // ms epoch when pending input started; cleared on Enter

  // Timestamp when session was added to state (used by GC to avoid premature removal)
  loadedAt?: number;
}

export interface Room {
  id: string;
  name: string;
  cwd: string;
  sessions: Session[];
  gitBranch?: string;
  pullRequest?: {
    number: number;
    url: string;
    title: string;
    state: string;
    isDraft: boolean;
  };
  gitWarning?: string;  // present when gh/git pr lookup failed
}

export interface OfficeSnapshot {
  rooms: Room[];
  updatedAt: string;
  bridgePath?: string;
  platform: string;  // process.platform: 'darwin' | 'win32' | 'linux'
}
