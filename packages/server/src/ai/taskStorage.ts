import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Task } from '../types.js';

/** Convert a cwd path to a stable filesystem-safe slug for the room tasks file. */
function cwdToRoomSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function getRoomTasksPath(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'rooms', `${cwdToRoomSlug(cwd)}.tasks.json`);
}

/** Read all tasks for a room (all sessions in that cwd). Newest-first. */
export function readRoomTasks(cwd: string): Task[] {
  try {
    const p = getRoomTasksPath(cwd);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as Task[];
    }
    return [];
  } catch {
    return [];
  }
}

/** Read tasks for a specific session within a room. */
export function readTasks(cwd: string, sessionId: string): Task[] {
  return readRoomTasks(cwd).filter(t => t.sessionId === sessionId);
}

export function writeRoomTasks(cwd: string, tasks: Task[]): void {
  try {
    const p = getRoomTasksPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2), 'utf-8');
  } catch { /* silently swallow */ }
}

/** Creates a new active task for a session, prepends to room storage, returns the task. */
export function createTask(cwd: string, sessionId: string, sessionName: string | undefined, createdAt: string): Task {
  const existing = readRoomTasks(cwd);
  const sessionTaskCount = existing.filter(t => t.sessionId === sessionId).length;
  const task: Task = {
    taskId: `${sessionId}-${sessionTaskCount + 1}`,
    sessionId,
    sessionName,
    state: 'active',
    createdAt,
  };
  writeRoomTasks(cwd, [task, ...existing]);
  return task;
}

/** Updates a task by taskId in the room file, returns the full updated array. */
export function updateTask(cwd: string, taskId: string, patch: Partial<Task>): Task[] {
  const tasks = readRoomTasks(cwd);
  const idx = tasks.findIndex(t => t.taskId === taskId);
  if (idx === -1) return tasks;
  tasks[idx] = { ...tasks[idx], ...patch };
  writeRoomTasks(cwd, tasks);
  return tasks;
}

/** Accept a done task by completedAt timestamp. Returns updated session tasks or null if not found. */
export function acceptTaskByCompletedAt(cwd: string, sessionId: string, completedAt: string): Task[] | null {
  const tasks = readRoomTasks(cwd);
  const idx = tasks.findIndex(t => t.sessionId === sessionId && t.completedAt === completedAt);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], accepted: true };
  writeRoomTasks(cwd, tasks);
  return tasks.filter(t => t.sessionId === sessionId && t.state === 'done');
}

// ── Completion hint (per-session, unchanged) ─────────────────────────────────

function getHintPath(sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'tasks', `${sessionId}.hint`);
}

export function saveCompletionHint(sessionId: string, hint: 'done'): void {
  try {
    const p = getHintPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, hint, 'utf-8');
  } catch { /* ignore */ }
}

export function loadCompletionHint(sessionId: string): 'done' | undefined {
  try {
    const content = fs.readFileSync(getHintPath(sessionId), 'utf-8').trim();
    if (content === 'done') return 'done';
  } catch { /* not found */ }
  return undefined;
}

export function clearCompletionHint(sessionId: string): void {
  try { fs.unlinkSync(getHintPath(sessionId)); } catch { /* ignore */ }
}

// ── Legacy stubs ──────────────────────────────────────────────────────────────

/** @deprecated Request summaries are replaced by Task.title. No-op kept for compat. */
export function saveRequestSummary(_sessionId: string, _summary: string): void {
  // no-op
}
