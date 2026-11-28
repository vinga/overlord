import { sessionStore } from '../session/sessionStore.js';
import type { OverlordSession, SessionReview } from '../types.js';

// ── Review marker (read) ─────────────────────────────────────────────────────

export interface ReviewState {
  review?: SessionReview;
}

/** Fields of the removed "parked" marker. Old records may still carry them;
 *  every write clears them so they drain out of the store over time. */
const RETIRED_FIELDS = { parkReason: undefined, parkedAt: undefined } as Partial<OverlordSession>;

/** Persist the marker. Every write drops the legacy `acknowledged` flag and
 *  the retired park fields — the migration is one-way. */
export function saveReview(sessionId: string, next: ReviewState): void {
  sessionStore.patchBySessionId(sessionId, {
    review: next.review,
    acknowledged: undefined,
    ...RETIRED_FIELDS,
  });
}

/** The single migration point: new field wins, legacy `acknowledged: true` reads
 *  as 'read'. A legacy on-disk `review: 'parked'` reads as no marker. */
export function readReview(rec?: OverlordSession | null): ReviewState {
  if (!rec) return {};
  if (rec.review === 'read') return { review: 'read' };
  if (rec.review) return {};
  return rec.acknowledged === true ? { review: 'read' } : {};
}

export function loadReview(sessionId: string): ReviewState {
  return readReview(sessionStore.getBySessionId(sessionId));
}

// ── Legacy stub ──────────────────────────────────────────────────────────────

/** @deprecated Request summaries are replaced by Task.title. No-op kept for compat. */
export function saveRequestSummary(_sessionId: string, _summary: string): void {
  // no-op
}
