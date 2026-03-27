export type WorkerState = 'working' | 'waiting' | 'thinking' | 'idle';

export type ActivityItemKind = 'message' | 'tool';

export interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for Edit tool calls
  newString?: string;            // for Edit tool calls
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
  color: string;
  subagents: Subagent[];
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
