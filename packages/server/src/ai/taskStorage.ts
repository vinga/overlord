import type { Task, OverlordSession } from '../types.js';
import { sessionStore } from '../session/sessionStore.js';

/**
 * Task persistence. Sources of truth are `completionSummaries` and `currentTask`
 * on each `OverlordSession` (keyed by overlordId). Plan-kind entries are stored
 * separately in `planStore` and projected into the wire Session at snapshot time.
 *
 * Tasks live at the overlord level so they carry through /clear and /compact.
 * API signatures keep the legacy `cwd` / `sessionId` params for caller compat;
 * callers that only know a sessionId are resolved to the owning overlord via
 * the sessionStore's secondary index.
 */

function gatherTasks(rec: OverlordSession | undefined): Task[] {
  if (!rec) return [];
  const out: Task[] = [];
  if (rec.currentTask) out.push(rec.currentTask);
  if (rec.completionSummaries) out.push(...rec.completionSummaries);
  return out;
}

/** Every task for every overlord whose cwd matches. */
export function readRoomTasks(cwd: string): Task[] {
  const out: Task[] = [];
  for (const rec of sessionStore.listActive()) {
    if (rec.cwd !== cwd) continue;
    out.push(...gatherTasks(rec));
  }
  return out;
}

export function readTasks(cwd: string, sessionId: string): Task[] {
  void cwd;
  return gatherTasks(sessionStore.getBySessionId(sessionId));
}

export function createTask(cwd: string, sessionId: string, sessionName: string | undefined, createdAt: string): Task {
  void cwd;
  const rec = sessionStore.getBySessionId(sessionId);
  const existingCount = gatherTasks(rec).length;
  const task: Task = {
    taskId: `${sessionId}-${existingCount + 1}`,
    sessionId,
    sessionName,
    state: 'active',
    createdAt,
  };
  if (rec) sessionStore.patch(rec.overlordId, { currentTask: task });
  return task;
}

/** Patch a task by taskId; moves currentTask → completionSummaries when state becomes 'done'. */
export function updateTask(cwd: string, taskId: string, patch: Partial<Task>): Task[] {
  void cwd;
  // Task ids are "{sessionId}-{n}". Recover the sessionId prefix.
  const sessionId = taskId.split('-').slice(0, -1).join('-') || taskId;
  const rec = sessionStore.getBySessionId(sessionId);
  if (!rec) return [];

  let currentTask = rec.currentTask;
  let completionSummaries = rec.completionSummaries ? [...rec.completionSummaries] : undefined;

  if (currentTask?.taskId === taskId) {
    const updated: Task = { ...currentTask, ...patch };
    if (updated.state === 'done') {
      completionSummaries = [updated, ...(completionSummaries ?? [])];
      currentTask = undefined;
    } else {
      currentTask = updated;
    }
  }

  if (completionSummaries) {
    const i = completionSummaries.findIndex(t => t.taskId === taskId);
    if (i !== -1) completionSummaries[i] = { ...completionSummaries[i], ...patch };
  }

  sessionStore.patch(rec.overlordId, { currentTask, completionSummaries });
  const fresh = sessionStore.getByOverlordId(rec.overlordId);
  return gatherTasks(fresh);
}

export function acceptTaskByCompletedAt(cwd: string, sessionId: string, completedAt: string): Task[] | null {
  void cwd;
  const rec = sessionStore.getBySessionId(sessionId);
  if (!rec || !rec.completionSummaries) return null;
  const idx = rec.completionSummaries.findIndex(t => t.completedAt === completedAt);
  if (idx === -1) return null;
  const completionSummaries = [...rec.completionSummaries];
  completionSummaries[idx] = { ...completionSummaries[idx], accepted: true };
  sessionStore.patch(rec.overlordId, { completionSummaries });
  return completionSummaries;
}

// ── Completion hint ──────────────────────────────────────────────────────────

export function saveCompletionHint(sessionId: string, hint: 'done'): void {
  sessionStore.patchBySessionId(sessionId, { completionHint: hint });
}

export function loadCompletionHint(sessionId: string): 'done' | undefined {
  return sessionStore.getBySessionId(sessionId)?.completionHint;
}

export function clearCompletionHint(sessionId: string): void {
  sessionStore.patchBySessionId(sessionId, { completionHint: undefined });
}

// ── Acknowledged flag ────────────────────────────────────────────────────────

export function saveAck(sessionId: string, acknowledged: boolean): void {
  sessionStore.patchBySessionId(sessionId, { acknowledged: acknowledged ? true : undefined });
}

export function loadAck(sessionId: string): boolean {
  return sessionStore.getBySessionId(sessionId)?.acknowledged === true;
}

// ── Legacy stub ──────────────────────────────────────────────────────────────

/** @deprecated Request summaries are replaced by Task.title. No-op kept for compat. */
export function saveRequestSummary(_sessionId: string, _summary: string): void {
  // no-op
}
