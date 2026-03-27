type WorkerState = 'working' | 'waiting' | 'thinking' | 'idle';

type ActivityItemKind = 'message' | 'tool';

interface ActivityItem {
  kind: ActivityItemKind;
  role?: 'user' | 'assistant';  // for kind='message'
  content: string;               // message text OR tool description
  toolName?: string;             // for kind='tool'
  oldString?: string;            // for kind='tool' + toolName='Edit'
  newString?: string;            // for kind='tool' + toolName='Edit'
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

interface Session {
  sessionId: string;
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

type TerminalMessage =
  | TerminalOutputMessage
  | TerminalSpawnedMessage
  | TerminalExitMessage
  | TerminalErrorMessage;

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

export type {
  WorkerState,
  ActivityItemKind,
  ActivityItem,
  Subagent,
  Session,
  Room,
  OfficeSnapshot,
  TerminalMessage,
  SnapshotMessage,
  TerminalSpawnRequest,
  TerminalInputRequest,
  TerminalInjectRequest,
  TerminalResizeRequest,
};
