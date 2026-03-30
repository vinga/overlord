import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runClaudeQuery } from './claudeQuery.js';

export interface TaskSummary {
  summary: string;
  completedAt: string; // ISO timestamp
  accepted?: boolean;
}

function getStoragePath(sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'overlord', 'tasks', `${sessionId}.json`);
}

export function readTaskSummaries(sessionId: string): TaskSummary[] {
  try {
    const p = getStoragePath(sessionId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as TaskSummary[];
  } catch {
    return [];
  }
}

function writeSummaries(sessionId: string, summaries: TaskSummary[]): void {
  try {
    const p = getStoragePath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(summaries, null, 2), 'utf-8');
  } catch {
    // ignore write errors
  }
}

export async function appendTaskSummary(sessionId: string, summary: string): Promise<TaskSummary[]> {
  const existing = readTaskSummaries(sessionId);

  // No existing summaries — always append directly, no Haiku call needed
  if (existing.length === 0) {
    const entry: TaskSummary = { summary, completedAt: new Date().toISOString() };
    const updated = [entry];
    writeSummaries(sessionId, updated);
    return updated;
  }

  // Build context from last 3 summaries for the Haiku prompt
  const last3 = existing.slice(-3);
  const numberedList = last3
    .map((s, i) => `${i + 1}. ${s.summary}`)
    .join('\n');

  try {
    const prompt =
      `You are a task summary deduplication assistant. Given a new task summary and recent previous summaries, decide what to do.\n\n` +
      `Previous summaries (most recent last):\n${numberedList}\n\n` +
      `New summary: "${summary}"\n\n` +
      `Choose exactly one action:\n` +
      `- "skip" — the new summary conveys the same meaning as an existing one\n` +
      `- "update_previous: <text>" — the new summary supersedes/extends the most recent; replace it with <text>\n` +
      `- "append" — this is a distinct new task; add it\n\n` +
      `Reply with just the action on one line.`;

    const response = (await runClaudeQuery(prompt, 30_000)).trim();
    const lower = response.toLowerCase();

    if (lower.startsWith('skip')) {
      return existing;
    }

    if (lower.startsWith('update_previous:')) {
      const newText = response.slice('update_previous:'.length).trim();
      const updated = [...existing];
      updated[updated.length - 1] = {
        summary: newText,
        completedAt: existing[existing.length - 1].completedAt,
      };
      writeSummaries(sessionId, updated);
      return updated;
    }

    // 'append' or any unrecognised response — fall through to append
  } catch {
    // Fallback: simple exact case-insensitive match against last entry only
    const last = existing[existing.length - 1];
    if (last && last.summary.trim().toLowerCase() === summary.trim().toLowerCase()) {
      return existing;
    }
  }

  // Append new entry
  const entry: TaskSummary = { summary, completedAt: new Date().toISOString() };
  const updated = [...existing, entry];
  writeSummaries(sessionId, updated);
  return updated;
}

export function acceptTaskSummary(sessionId: string, completedAt: string): TaskSummary[] | null {
  const summaries = readTaskSummaries(sessionId);
  const idx = summaries.findIndex(s => s.completedAt === completedAt);
  if (idx === -1) return null;
  summaries[idx] = { ...summaries[idx], accepted: true };
  writeSummaries(sessionId, summaries);
  return summaries;
}

export function saveCompletionHint(sessionId: string, hint: 'done'): void {
  try {
    const p = getStoragePath(sessionId).replace('.json', '.hint');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, hint, 'utf-8');
  } catch { /* ignore */ }
}

export function loadCompletionHint(sessionId: string): 'done' | undefined {
  try {
    const p = getStoragePath(sessionId).replace('.json', '.hint');
    const content = fs.readFileSync(p, 'utf-8').trim();
    if (content === 'done') return 'done';
  } catch { /* not found */ }
  return undefined;
}

export function clearCompletionHint(sessionId: string): void {
  try {
    const p = getStoragePath(sessionId).replace('.json', '.hint');
    fs.unlinkSync(p);
  } catch { /* ignore */ }
}
