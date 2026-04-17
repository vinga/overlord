import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.claude', 'overlord', 'pty-logs');

const DEFAULT_PER_FILE_MB = 2;
const DEFAULT_TOTAL_MB = 500;
const ORPHAN_TTL_DAYS = 30;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function perFileCapBytes(): number {
  const mb = Number(process.env.OVERLORD_SHELL_LOG_PER_FILE_MB) || DEFAULT_PER_FILE_MB;
  return Math.max(1, mb) * 1024 * 1024;
}

function totalCapBytes(): number {
  const mb = Number(process.env.OVERLORD_SHELL_LOG_TOTAL_MB) || DEFAULT_TOTAL_MB;
  return Math.max(1, mb) * 1024 * 1024;
}

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function isSafeId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function logPath(sessionId: string): string {
  return path.join(LOG_DIR, `${sessionId}.log`);
}

function metaPath(sessionId: string): string {
  return path.join(LOG_DIR, `${sessionId}.meta.json`);
}

export interface ShellHistoryMeta {
  sessionId: string;
  cwd: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
}

export function writeMeta(sessionId: string, meta: Partial<ShellHistoryMeta> & { cwd: string }): void {
  if (!isSafeId(sessionId)) return;
  ensureDir();
  const existing = readMeta(sessionId);
  const merged: ShellHistoryMeta = {
    sessionId,
    cwd: meta.cwd,
    name: meta.name ?? existing?.name,
    createdAt: existing?.createdAt ?? Date.now(),
    lastSeenAt: Date.now(),
  };
  try {
    fs.writeFileSync(metaPath(sessionId), JSON.stringify(merged), 'utf8');
  } catch (err) {
    console.warn(`[shellHistoryLog] writeMeta failed for ${sessionId}:`, (err as Error).message);
  }
}

export function readMeta(sessionId: string): ShellHistoryMeta | null {
  if (!isSafeId(sessionId)) return null;
  try {
    const raw = fs.readFileSync(metaPath(sessionId), 'utf8');
    return JSON.parse(raw) as ShellHistoryMeta;
  } catch {
    return null;
  }
}

export function appendOutput(sessionId: string, data: Buffer | string): void {
  if (!isSafeId(sessionId)) return;
  ensureDir();
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const p = logPath(sessionId);
  try {
    fs.appendFileSync(p, buf);
    const st = fs.statSync(p);
    const cap = perFileCapBytes();
    if (st.size > cap * 1.25) {
      // Truncate from head to keep the tail of length cap
      const fd = fs.openSync(p, 'r');
      try {
        const keepStart = st.size - cap;
        const tail = Buffer.alloc(cap);
        fs.readSync(fd, tail, 0, cap, keepStart);
        fs.writeFileSync(p, tail);
      } finally {
        fs.closeSync(fd);
      }
    }
    // Touch meta lastSeenAt via mtime implicitly; no per-append meta write.
  } catch (err) {
    console.warn(`[shellHistoryLog] appendOutput failed for ${sessionId}:`, (err as Error).message);
  }
}

export function readAll(sessionId: string): Buffer {
  if (!isSafeId(sessionId)) return Buffer.alloc(0);
  try {
    return fs.readFileSync(logPath(sessionId));
  } catch {
    return Buffer.alloc(0);
  }
}

export function hasLog(sessionId: string): boolean {
  if (!isSafeId(sessionId)) return false;
  try {
    return fs.statSync(logPath(sessionId)).size > 0;
  } catch {
    return false;
  }
}

export function deleteLog(sessionId: string): void {
  if (!isSafeId(sessionId)) return;
  for (const p of [logPath(sessionId), metaPath(sessionId)]) {
    try { fs.unlinkSync(p); } catch { /* missing is fine */ }
  }
}

interface LogFileInfo {
  sessionId: string;
  logPath: string;
  mtime: number;
  size: number;
}

function listLogs(): LogFileInfo[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  const out: LogFileInfo[] = [];
  for (const entry of fs.readdirSync(LOG_DIR)) {
    if (!entry.endsWith('.log')) continue;
    const sessionId = entry.slice(0, -4);
    if (!isSafeId(sessionId)) continue;
    const p = path.join(LOG_DIR, entry);
    try {
      const st = fs.statSync(p);
      out.push({ sessionId, logPath: p, mtime: st.mtimeMs, size: st.size });
    } catch { /* skip */ }
  }
  return out;
}

export function listAll(): Array<{ sessionId: string; meta: ShellHistoryMeta | null; mtime: number; size: number }> {
  return listLogs().map(l => ({
    sessionId: l.sessionId,
    meta: readMeta(l.sessionId),
    mtime: l.mtime,
    size: l.size,
  }));
}

export function sweep(isKnownSession: (sessionId: string) => boolean): void {
  const now = Date.now();
  const ttlMs = ORPHAN_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const l of listLogs()) {
    if (isKnownSession(l.sessionId)) continue;
    if (now - l.mtime > ttlMs) {
      deleteLog(l.sessionId);
      console.log(`[shellHistoryLog] swept orphan ${l.sessionId} (age ${Math.round((now - l.mtime) / 86400000)}d)`);
    }
  }
}

export function enforceTotalCap(): void {
  const cap = totalCapBytes();
  const logs = listLogs().sort((a, b) => a.mtime - b.mtime);
  let total = logs.reduce((acc, l) => acc + l.size, 0);
  let i = 0;
  while (total > cap && i < logs.length) {
    const victim = logs[i++];
    deleteLog(victim.sessionId);
    total -= victim.size;
    console.log(`[shellHistoryLog] evicted ${victim.sessionId} to enforce total cap`);
  }
}

let periodicTimer: NodeJS.Timeout | null = null;

export function startPeriodicSweep(isKnownSession: (sessionId: string) => boolean): void {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => {
    sweep(isKnownSession);
    enforceTotalCap();
  }, SWEEP_INTERVAL_MS);
  periodicTimer.unref();
}

export function stopPeriodicSweep(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}
