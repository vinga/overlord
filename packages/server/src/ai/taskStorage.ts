import type { Task, OverlordSession } from '../types.js';
import { sessionStore } from '../session/sessionStore.js';

/**
 * Task persistence. Sources of truth are the `planTasks`, `completionSummaries`,
 * and `currentTask` fields on each `OverlordSession` (keyed by overlordId).
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
  if (rec.planTasks) out.push(...rec.planTasks);
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

export function createPlanTask(
  cwd: string,
  sessionId: string,
  sessionName: string | undefined,
  planToolUseId: string,
  planContent: string,
  createdAt: string,
  planStatus: 'approved' | 'rejected' | 'pending' = 'approved',
): Task | undefined {
  void cwd;
  const rec = sessionStore.getBySessionId(sessionId);
  if (!rec) return undefined;

  const planTasks = [...(rec.planTasks ?? [])];
  const dupIdx = planTasks.findIndex(t => t.planToolUseId === planToolUseId);
  if (dupIdx !== -1) {
    const dup = planTasks[dupIdx];
    if (dup.planStatus !== planStatus) {
      planTasks[dupIdx] = { ...dup, planStatus };
      sessionStore.patch(rec.overlordId, { planTasks });
      return planTasks[dupIdx];
    }
    return dup;
  }

  const totalCount = gatherTasks(rec).length;
  const title = deriveTitleFromPlan(planContent);
  const task: Task = {
    taskId: `${sessionId}-${totalCount + 1}`,
    sessionId,
    sessionName,
    state: 'done',
    kind: 'plan',
    title,
    createdAt,
    completedAt: createdAt,
    planContent,
    planToolUseId,
    planStatus,
  };
  planTasks.unshift(task);
  sessionStore.patch(rec.overlordId, { planTasks });
  return task;
}

function deriveTitleFromPlan(plan: string): string {
  const firstLine = plan.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? 'Plan';
  const stripped = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '');
  return stripped.length > 80 ? stripped.slice(0, 77) + '…' : stripped;
}

/** Patch a task by taskId; moves currentTask → completionSummaries when state becomes 'done'. */
export function updateTask(cwd: string, taskId: string, patch: Partial<Task>): Task[] {
  void cwd;
  // Task ids are "{sessionId}-{n}". Recover the sessionId prefix.
  const sessionId = taskId.split('-').slice(0, -1).join('-') || taskId;
  const rec = sessionStore.getBySessionId(sessionId);
  if (!rec) return [];

  let currentTask = rec.currentTask;
  let planTasks = rec.planTasks ? [...rec.planTasks] : undefined;
  let completionSummaries = rec.completionSummaries ? [...rec.completionSummaries] : undefined;

  if (currentTask?.taskId === taskId) {
    const updated: Task = { ...currentTask, ...patch };
    if (updated.state === 'done') {
      completionSummaries = [updated, ...(completionSummaries ?? [])];
      currentTask = undefined;
    } else {
      currentTask = updated;
    }
  } else if (planTasks) {
    const i = planTasks.findIndex(t => t.taskId === taskId);
    if (i !== -1) planTasks[i] = { ...planTasks[i], ...patch };
  }

  if (completionSummaries) {
    const i = completionSummaries.findIndex(t => t.taskId === taskId);
    if (i !== -1) completionSummaries[i] = { ...completionSummaries[i], ...patch };
  }

  sessionStore.patch(rec.overlordId, { currentTask, planTasks, completionSummaries });
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
