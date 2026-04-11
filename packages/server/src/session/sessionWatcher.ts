import type { SessionProvider } from '../types.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { FSWatcher } from 'chokidar';
const QUERY_WORKER_CWD = path.join(os.homedir(), '.claude', 'overlord', 'query-worker');

export interface RawSession {
  pid: number;
  sessionId: string;
  provider?: SessionProvider;
  cwd: string;
  startedAt: number;
  kind?: string;
  name?: string;
  proposedName?: string;
  transcriptPath?: string;
}

export interface SessionSource {
  on(event: 'added', listener: (raw: RawSession) => void): this;
  on(event: 'changed', listener: (raw: RawSession) => void): this;
  on(event: 'removed', listener: (sessionId: string) => void): this;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessionsDir: string;
  private sessionIdByPath = new Map<string, string>();

  constructor() {
    super();
    this.sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  }

  start(): void {
    // Read all existing session files and emit 'added' for each
    try {
      if (fs.existsSync(this.sessionsDir)) {
        const files = fs.readdirSync(this.sessionsDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(this.sessionsDir, file);
          const data = this.readSession(filePath);
          if (data) {
            this.sessionIdByPath.set(filePath, data.sessionId);
            this.emit('added', data);
          }
        }
      }
    } catch {
      // ignore initial read errors
    }

    this.watcher = chokidar.watch(this.sessionsDir, {
      ignoreInitial: true,
      depth: 0,
    });

    this.watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.json')) return;
      const data = this.readSession(filePath);
      if (data) {
        this.sessionIdByPath.set(filePath, data.sessionId);
        this.emit('added', data);
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (!filePath.endsWith('.json')) return;
      const data = this.readSession(filePath);
      if (data) {
        this.sessionIdByPath.set(filePath, data.sessionId);
        this.emit('changed', data);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      if (!filePath.endsWith('.json')) return;
      const sessionId = this.sessionIdByPath.get(filePath);
      this.sessionIdByPath.delete(filePath);
      if (sessionId) {
        this.emit('removed', sessionId);
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private readSession(filePath: string): RawSession | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as RawSession;
      if (data.cwd && path.normalize(data.cwd) === path.normalize(QUERY_WORKER_CWD)) {
        return { ...data, provider: 'claude', kind: 'query-worker' };
      }
      return { ...data, provider: 'claude' };
    } catch {
      return null;
    }
  }
}
