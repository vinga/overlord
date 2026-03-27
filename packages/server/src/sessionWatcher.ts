import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { FSWatcher } from 'chokidar';

export interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessionsDir: string;

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
        this.emit('added', data);
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (!filePath.endsWith('.json')) return;
      const data = this.readSession(filePath);
      if (data) {
        this.emit('changed', data);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      if (!filePath.endsWith('.json')) return;
      const basename = path.basename(filePath, '.json');
      this.emit('removed', basename);
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
      return data;
    } catch {
      return null;
    }
  }
}
