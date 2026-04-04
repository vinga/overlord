export interface LogEntry {
  id: number;
  timestamp: string; // ISO
  event: 'session:created' | 'session:removed' | 'session:replaced' | 'session:state' | 'session:resumed' | 'session:killed' | 'pty:started' | 'clear:detected' | 'info';
  sessionId?: string;
  sessionName?: string;
  detail: string;
  extra?: string; // e.g. "idle → working"
}

let counter = 0;
const buffer: LogEntry[] = [];
const MAX = 500;
let broadcastFn: ((entry: LogEntry) => void) | null = null;

export function initLogger(broadcast: (entry: LogEntry) => void) {
  broadcastFn = broadcast;
}

export function log(event: LogEntry['event'], detail: string, opts?: { sessionId?: string; sessionName?: string; extra?: string }) {
  const entry: LogEntry = {
    id: ++counter,
    timestamp: new Date().toISOString(),
    event,
    detail,
    ...opts,
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  broadcastFn?.(entry);
  // Also print to stdout
  console.log(`[${entry.event}] ${detail}${opts?.extra ? ' | ' + opts.extra : ''}`);
}

export function getBuffer(): LogEntry[] {
  return [...buffer];
}
