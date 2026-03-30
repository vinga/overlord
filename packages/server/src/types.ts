export type WorkerState = 'working' | 'thinking' | 'waiting' | 'closed';

export type ActivityItemKind = 'message' | 'tool' | 'thinking';

export interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for Edit tool calls
  newString?: string;            // for Edit tool calls
  isRedacted?: boolean;
  inputJson?: string;            // full tool input as JSON (truncated)
  durationMs?: number;           // for kind='tool': how long the tool call took
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

export interface Session {
  sessionId: string;
  slug?: string;
  proposedName?: string;
  pid: number;
  startedAt: number;
  cwd: string;
  state: WorkerState;
  lastActivity: string;
  lastMessage?: string;
  activityFeed?: ActivityItem[];
  model?: string;
  inputTokens?: number;
  compactCount?: number;
  isCompacting?: boolean;
  ideName?: string;
  launchMethod: 'terminal' | 'ide' | 'overlord-pty';
  color: string;
  subagents: Subagent[];
  resumedFrom?: string;
  needsPermission?: boolean;
  permissionPromptText?: string;
  permissionApprovedAt?: number;  // timestamp ms — suppress re-detection for 30s
  completionHint?: 'done' | 'awaiting';
  completionHintByUser?: boolean;
  manuallyDone?: boolean;
  completionSummaries?: Array<{ summary: string; completedAt: string }>;
  userAccepted?: boolean;
  currentTaskLabel?: string;
  isWorker?: boolean;
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
}
