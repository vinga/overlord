import type { Room, Session } from '../types';

/**
 * Queue classification for the Inbox rail.
 *
 * Every non-archived session that is blocked on the user (or idle) lands in
 * exactly ONE bucket — the first one it matches, checked in `QUEUE_BUCKETS`
 * order. Sessions that are actively running produce no row at all.
 *
 * There is no "finished" bucket. Guessing that an agent is done from its last
 * message was removed — `waiting` is the honest signal, and everything more
 * specific (approval, question, plan, error) is derived from real state.
 */
export type QueueBucketId =
  | 'approval'
  | 'question'
  | 'plan'
  | 'error'
  | 'sleeping'
  | 'idle'
  | 'parked';

export interface QueueBucketMeta {
  id: QueueBucketId;
  /** Section header in grouped mode. */
  label: string;
  /** Short chip text in flat mode. */
  chip: string;
  /** Whether the section starts expanded. */
  defaultExpanded: boolean;
  /** Whether rows in this bucket count toward the header badge. */
  countsToBadge: boolean;
  /** Whether rows appear in flat (by-time) mode. */
  inFlat: boolean;
}

/**
 * Ordered, most-blocking first. `sleeping` sits above `idle`: a session with a
 * pending wakeup or a background command is waiting on a machine, not on you.
 * `parked` sits last and collapsed — the user set it aside on purpose.
 */
export const QUEUE_BUCKETS: QueueBucketMeta[] = [
  { id: 'approval', label: 'Needs approval', chip: 'approval', defaultExpanded: true, countsToBadge: true, inFlat: true },
  { id: 'question', label: 'Answer a question', chip: 'question', defaultExpanded: true, countsToBadge: true, inFlat: true },
  { id: 'plan', label: 'Plan to approve', chip: 'plan', defaultExpanded: true, countsToBadge: true, inFlat: true },
  { id: 'error', label: 'Error', chip: 'error', defaultExpanded: true, countsToBadge: true, inFlat: true },
  { id: 'sleeping', label: 'Sleeping', chip: 'sleeping', defaultExpanded: false, countsToBadge: false, inFlat: false },
  { id: 'idle', label: 'Idle', chip: 'idle', defaultExpanded: true, countsToBadge: false, inFlat: true },
  { id: 'parked', label: 'Parked', chip: 'parked', defaultExpanded: false, countsToBadge: false, inFlat: false },
];

const BUCKET_BY_ID = new Map(QUEUE_BUCKETS.map(b => [b.id, b]));

export function bucketMeta(id: QueueBucketId): QueueBucketMeta {
  return BUCKET_BY_ID.get(id)!;
}

/**
 * Which bucket a session belongs to, or `null` if it produces no queue row
 * (running, closed, or archived).
 *
 * `parked` wins over everything except archival, and is checked before the
 * `waiting` gate: parking is sticky, so a parked session that resumes working
 * stays in the Parked section instead of vanishing from the rail.
 */
export function classifySession(s: Session): QueueBucketId | null {
  if (s.isArchived) return null;
  if (s.review === 'parked') return 'parked';
  if (s.state !== 'waiting') return null;
  return waitingBucket(s);
}

/** Bucket for a session already known to be waiting on someone. */
function waitingBucket(s: Session): QueueBucketId {
  if (s.needsPermission) return 'approval';
  // A stale question (transcript has it, the TUI no longer shows the menu) is not
  // something the user can answer — it must not sit in the "answer a question" queue.
  if (!s.questionStale && s.pendingQuestion && s.pendingQuestion.questions.length > 0) return 'question';
  if (s.latestPlan?.status === 'pending') return 'plan';
  if (s.unknownCommand || s.bridgeDead) return 'error';
  if (s.scheduledWakeupAt != null) return 'sleeping';
  // Waiting on a background command is a machine wait, not a human one — same
  // bucket as a scheduled wakeup, so it never sits in the user's idle queue.
  if (s.backgroundTasks && s.backgroundTasks.length > 0) return 'sleeping';
  return 'idle';
}

/**
 * The bucket a parked session *would* be in. Parking hides a row from the badge,
 * so the parked row still shows this as its chip — "parked, but it's now asking
 * for approval" stays legible instead of silently disappearing.
 */
export function liveBucketOf(s: Session): QueueBucketId | undefined {
  if (s.state !== 'waiting') return undefined;
  const live = waitingBucket(s);
  return live === 'idle' ? undefined : live;
}

/** A single renderable queue entry. */
export interface QueueItem {
  /** Stable React key + the id every callback takes. */
  key: string;
  session: Session;
  bucket: QueueBucketId;
  /** Display name, already resolved through customNames. */
  name: string;
  roomName: string;
  /** ms epoch of the session's last transcript activity — the sort key. */
  activityAt: number;
  /** Second-line context: the prompt, question, plan title, or error. */
  detail?: string;
  /** For `parked` rows only: the bucket the session would otherwise be in. */
  liveBucket?: QueueBucketId;
}

export interface QueueBucketGroup {
  meta: QueueBucketMeta;
  items: QueueItem[];
}

export interface QueueModel {
  groups: QueueBucketGroup[];
  /** All items except `sleeping`, sorted purely by time. */
  flat: QueueItem[];
  /** Count across badge-counting buckets — what the header pill shows. */
  badgeCount: number;
  /** Sessions actively running; shown only as a footer tally. */
  workingCount: number;
}

const MAX_DETAIL = 90;

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_DETAIL ? clean.slice(0, MAX_DETAIL - 1) + '…' : clean;
}

function detailFor(s: Session, bucket: QueueBucketId): string | undefined {
  switch (bucket) {
    case 'approval':
      return s.permissionPromptText ? truncate(s.permissionPromptText) : undefined;
    case 'question':
      return s.pendingQuestion?.questions[0]?.question
        ? truncate(s.pendingQuestion.questions[0].question)
        : undefined;
    case 'plan':
      return s.latestPlan?.title ? truncate(s.latestPlan.title) : undefined;
    case 'error':
      return s.unknownCommand ? `${s.unknownCommand} is not a command` : 'bridge lost';
    case 'parked':
      // Reason is optional — fall back to the last message like any other row.
      return s.parkReason ? truncate(s.parkReason) : (s.lastMessage ? truncate(s.lastMessage) : undefined);
    default:
      return s.lastMessage ? truncate(s.lastMessage) : undefined;
  }
}

function displayName(s: Session, customNames: Record<string, string>): string {
  return customNames[s.sessionId] ?? s.proposedName ?? s.slug ?? s.sessionId.slice(0, 8);
}

/**
 * Build the whole rail model from a snapshot's rooms.
 *
 * Pure and allocation-bounded — call it inside a single `useMemo` keyed on the
 * snapshot reference (see the React Render Hygiene rule in CLAUDE.md).
 *
 * @param sort 'oldest' puts the longest-waiting agent first (queue semantics).
 */
export function buildQueue(
  rooms: Room[],
  customNames: Record<string, string>,
  sort: 'oldest' | 'newest' = 'oldest',
): QueueModel {
  const byBucket = new Map<QueueBucketId, QueueItem[]>();
  let workingCount = 0;

  for (const room of rooms) {
    for (const session of room.sessions) {
      // Parked is checked first: a parked session that resumed working belongs in
      // the Parked section, not in the footer tally.
      const bucket = classifySession(session);
      if (!bucket) {
        if (session.state === 'working' || session.state === 'thinking') workingCount++;
        continue;
      }

      const parsed = Date.parse(session.lastActivity);
      const item: QueueItem = {
        key: session.overlordId ?? session.sessionId,
        session,
        bucket,
        name: displayName(session, customNames),
        roomName: room.name,
        activityAt: Number.isNaN(parsed) ? 0 : parsed,
        detail: detailFor(session, bucket),
        liveBucket: bucket === 'parked' ? liveBucketOf(session) : undefined,
      };
      const list = byBucket.get(bucket);
      if (list) list.push(item);
      else byBucket.set(bucket, [item]);
    }
  }

  const dir = sort === 'oldest' ? 1 : -1;
  const byTime = (a: QueueItem, b: QueueItem) => (a.activityAt - b.activityAt) * dir;

  const groups: QueueBucketGroup[] = [];
  let badgeCount = 0;
  const flat: QueueItem[] = [];

  for (const meta of QUEUE_BUCKETS) {
    const items = byBucket.get(meta.id);
    if (!items || items.length === 0) continue;
    items.sort(byTime);
    groups.push({ meta, items });
    if (meta.countsToBadge) badgeCount += items.length;
    if (meta.inFlat) flat.push(...items);
  }
  flat.sort(byTime);

  return { groups, flat, badgeCount, workingCount };
}

/** Compact age label. Sub-minute resolves to "now" — the rail ticks at 30s. */
export function formatAge(activityAt: number, now: number): string {
  if (!activityAt) return '';
  const secs = Math.max(0, Math.floor((now - activityAt) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Wakeup fire time, for `sleeping` rows (they show a future time, not an age). */
export function formatWakeup(scheduledWakeupAt: number): string {
  return new Date(scheduledWakeupAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Elapsed since a background command started. Unlike a scheduled wakeup there is
 * no fire time to count down to, so `sleeping` rows backed by a background task
 * show how long it has been running instead.
 */
export function formatElapsed(startedAt: string | undefined, now: number = Date.now()): string {
  if (!startedAt) return '';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '';
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`;
}
