import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import type { RawSession } from './sessionWatcher.js';

const MAX_INITIAL_AGE_MS = 24 * 60 * 60 * 1000;

export class CodexSessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessionsDir: string;
  private sessionIdByPath = new Map<string, string>();

  constructor() {
    super();
    this.sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  }

  start(): void {
    try {
      this.scanDir(this.sessionsDir);
    } catch {
      // ignore initial read errors
    }

    this.watcher = chokidar.watch(this.sessionsDir, {
      ignoreInitial: true,
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    });

    this.watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      const data = this.readSession(filePath);
      if (data) {
        this.sessionIdByPath.set(filePath, data.sessionId);
        this.emit('added', data);
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      const data = this.readSession(filePath);
      if (data) {
        this.sessionIdByPath.set(filePath, data.sessionId);
        this.emit('changed', data);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      const sessionId = this.sessionIdByPath.get(filePath);
      this.sessionIdByPath.delete(filePath);
      if (sessionId) this.emit('removed', sessionId);
    });
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  private scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanDir(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (Date.now() - stat.mtimeMs > MAX_INITIAL_AGE_MS) continue;
      } catch {
        continue;
      }
      const data = this.readSession(fullPath);
      if (data) {
        this.sessionIdByPath.set(fullPath, data.sessionId);
        this.emit('added', data);
      }
    }
  }

  private readSession(filePath: string): RawSession | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      let content = '';
      try {
        const stat = fs.fstatSync(fd);
        const readSize = Math.min(stat.size, 16 * 1024);
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, 0);
        content = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }

      const firstLine = content.split('\n').find(line => line.trim().length > 0);
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: { id?: string; cwd?: string; timestamp?: string };
      };
      if (parsed.type !== 'session_meta' || !parsed.payload?.id || !parsed.payload.cwd) return null;
      return {
        pid: 0,
        provider: 'codex',
        sessionId: parsed.payload.id,
        cwd: parsed.payload.cwd,
        startedAt: parsed.payload.timestamp ? new Date(parsed.payload.timestamp).getTime() : Date.now(),
        transcriptPath: filePath,
      };
    } catch {
      return null;
    }
  }
}
