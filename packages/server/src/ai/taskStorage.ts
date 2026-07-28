import { sessionStore } from '../session/sessionStore.js';
import type { OverlordSession, SessionReview } from '../types.js';

// ── Review marker (read / parked) ────────────────────────────────────────────

/** Max length of a park reason — enforced here and at the REST boundary. */
export const PARK_REASON_MAX = 280;

export interface ReviewState {
  review?: SessionReview;
  parkReason?: string;
  parkedAt?: number;
}

/** Persist the marker. Reason/timestamp only survive with 'parked'. Every write
 *  drops the legacy `acknowledged` flag — the migration is one-way. */
export function saveReview(sessionId: string, next: ReviewState): void {
  sessionStore.patchBySessionId(sessionId, {
    review: next.review,
    parkReason: next.review === 'parked' ? next.parkReason : undefined,
    parkedAt: next.review === 'parked' ? next.parkedAt : undefined,
    acknowledged: undefined,
  });
}

/** The single migration point: new field wins, legacy `acknowledged: true` reads as 'read'. */
export function readReview(rec?: OverlordSession | null): ReviewState {
  if (!rec) return {};
  if (rec.review) {
    return rec.review === 'parked'
      ? { review: 'parked', parkReason: rec.parkReason, parkedAt: rec.parkedAt }
      : { review: 'read' };
  }
  return rec.acknowledged === true ? { review: 'read' } : {};
}

export function loadReview(sessionId: string): ReviewState {
  return readReview(sessionStore.getBySessionId(sessionId));
}

/** Trim + cap a user-supplied reason. Empty normalizes to undefined. */
export function normalizeParkReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, PARK_REASON_MAX);
}

// ── Legacy stub ──────────────────────────────────────────────────────────────

/** @deprecated Request summaries are replaced by Task.title. No-op kept for compat. */
export function saveRequestSummary(_sessionId: string, _summary: string): void {
  // no-op
}
