import type { BackgroundProgress, Session } from '../types.js';
import { takeEndedPushCards, type EndedPushCard } from './progressStore.js';

/**
 * Completion ping for pushed progress cards. Claude Code re-invokes the agent
 * with a <task-notification> when a background command exits; Codex has no
 * such thing, so a detached `ovr-watch --detach` would finish unseen. Overlord
 * types one line into the session instead — once, when it is idle.
 *
 * OVERLORD_PROGRESS_NOTIFY: '1'/'true' all providers, '0'/'false' none,
 * unset → Codex only (Claude already gets its own notification).
 */

const MAX_PENDING_MS = 60 * 60 * 1000;
const pending: Array<EndedPushCard & { queuedAt: number }> = [];

export function notifyEnabledFor(session: Session, env = process.env.OVERLORD_PROGRESS_NOTIFY): boolean {
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return session.provider === 'codex';
}

export function completionText(card: BackgroundProgress): string {
  const label = card.description ?? card.rows[0]?.label ?? card.taskId;
  const status = card.status === 'failed' ? 'FAILED' : card.status;
  const detail = card.rows.length > 1
    ? card.rows.map(r => `${r.label ?? r.id} ${r.final ?? r.state ?? ''}`.trim()).join(', ')
    : (card.rows[0]?.message ?? card.lastLine ?? '');
  return `[ovr-watch] ${label}: ${status}${detail ? ` — ${detail}` : ''}`.slice(0, 400);
}

export interface NotifyDeps {
  getSession: (sessionId: string) => Session | undefined;
  /** Type `text` into the session's PTY and submit it. False when it has no PTY. */
  inject: (session: Session, text: string) => boolean;
  now?: number;
}

/** Queue newly ended push cards, then send every ping whose session is idle. */
export function flushProgressNotifications(deps: NotifyDeps): void {
  const now = deps.now ?? Date.now();
  for (const e of takeEndedPushCards()) pending.push({ ...e, queuedAt: now });
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    const session = deps.getSession(p.sessionId);
    if (!session || session.state === 'closed' || now - p.queuedAt > MAX_PENDING_MS || !notifyEnabledFor(session)) {
      pending.splice(i, 1);
      continue;
    }
    // Typing into a busy TUI would interleave with its turn: wait for idle.
    if (session.state !== 'waiting') continue;
    if (deps.inject(session, completionText(p.card))) pending.splice(i, 1);
  }
}

export function _resetProgressNotifyForTest(): void {
  pending.length = 0;
}
