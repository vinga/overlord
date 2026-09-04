import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeSnapshot, Session, SessionReview } from '../types';
import {
  buildQueue,
  formatAge,
  formatWakeup,
  formatElapsed,
  QUEUE_BUCKETS,
  type QueueBucketId,
  type QueueItem,
} from '../lib/queueBuckets';
import { useQueueRailState } from '../hooks/useQueueRailState';
import { PARK_REASON_MAX } from '../lib/review';
import styles from './QueueRail.module.css';

interface QueueRailProps {
  snapshot: OfficeSnapshot | null;
  customNames: Record<string, string>;
  onSelectSession: (session: Session) => void;
  /** Set or clear the review marker. `reason` applies to 'parked' only. */
  onSetReview?: (sessionId: string, review: SessionReview | null, reason?: string) => void;
  /** ✓ button — toggles 'read'. Never touches a parked session. */
  onToggleRead?: (sessionId: string) => void;
  selectedSessionId?: string | null;
  /** Reports the rail's rendered width so the office grid can offset for it. */
  onWidthChange?: (width: number) => void;
}

const RAIL_WIDTH = 288;
const STRIP_WIDTH = 34;
/** Ages render at 30s granularity — a faster ticker just burns renders. */
const TICK_MS = 30_000;

/** Buckets whose row exposes the ✓ read button. `sleeping` is a machine wait —
 *  nothing for the user to mark read; `parked` shows un-park instead. */
const READ_BUCKETS = new Set<QueueBucketId>(['approval', 'question', 'plan', 'error', 'idle']);

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`${styles.caret} ${open ? styles.caretOpen : ''}`}
      width="9"
      height="9"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface QueueRowProps {
  item: QueueItem;
  now: number;
  showChip: boolean;
  selected: boolean;
  onSelect: (session: Session) => void;
  /** ✓ read toggle — omitted for buckets that can't be marked read. */
  onClear?: (sessionId: string) => void;
  onSetReview?: (sessionId: string, review: SessionReview | null, reason?: string) => void;
}

const QueueRow = memo(function QueueRow({ item, now, showChip, selected, onSelect, onClear, onSetReview }: QueueRowProps) {
  const { session, bucket } = item;
  const isParked = session.review === 'parked';
  const dimmed = session.review != null;
  const [parking, setParking] = useState(false);
  const [reason, setReason] = useState('');

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClear?.(session.sessionId);
  }, [onClear, session.sessionId]);

  const openPark = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setReason(session.parkReason ?? '');
    setParking(true);
  }, [session.parkReason]);

  // Escape unmounts the input, which fires blur — without this guard the cancel
  // would immediately be followed by a commit.
  const cancelled = useRef(false);

  const commitPark = useCallback(() => {
    if (cancelled.current) { cancelled.current = false; return; }
    onSetReview?.(session.sessionId, 'parked', reason);
    setParking(false);
  }, [onSetReview, session.sessionId, reason]);

  const unpark = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSetReview?.(session.sessionId, null);
  }, [onSetReview, session.sessionId]);

  // `sleeping` covers two waits: a scheduled wakeup (shows its fire time) and a
  // background command (no fire time — show how long it has been running).
  const age = bucket === 'sleeping' && session.scheduledWakeupAt != null
    ? formatWakeup(session.scheduledWakeupAt)
    : bucket === 'sleeping' && session.backgroundTasks?.length
      ? formatElapsed(session.backgroundTasks[0].startedAt, now)
      : formatAge(item.activityAt, now);

  // A parked row keeps showing why it would otherwise be blocking.
  const chipBucket = bucket === 'parked' ? (item.liveBucket ?? 'parked') : bucket;

  return (
    <div
      className={`${styles.row} ${styles[`row_${bucket}`] ?? ''} ${selected ? styles.rowSelected : ''} ${dimmed ? styles.rowDimmed : ''}`}
      onClick={() => onSelect(session)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session); } }}
      title={isParked && session.parkReason ? `Parked · ${session.parkReason}` : (item.detail ?? item.name)}
    >
      <span className={styles.dot} style={{ background: session.color }} aria-hidden="true" />
      <div className={styles.rowBody}>
        <div className={styles.rowTop}>
          <span className={styles.rowName}>{item.name}</span>
          <span className={styles.rowAge}>{age}</span>
        </div>
        <div className={styles.rowBottom}>
          {(showChip || (bucket === 'parked' && item.liveBucket)) && (
            <span className={`${styles.chip} ${styles[`chip_${chipBucket}`] ?? ''}`}>{chipBucket}</span>
          )}
          <span className={styles.rowRoom}>{item.roomName}</span>
          {item.detail && <span className={styles.rowSep} aria-hidden="true">·</span>}
          {item.detail && <span className={styles.rowDetail}>{item.detail}</span>}
        </div>
        {parking && (
          <input
            className={styles.parkInput}
            autoFocus
            maxLength={PARK_REASON_MAX}
            placeholder="why parked? (optional)"
            value={reason}
            onClick={e => e.stopPropagation()}
            onChange={e => setReason(e.target.value)}
            onBlur={commitPark}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); commitPark(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setParking(false); }
            }}
          />
        )}
      </div>
      <div className={styles.rowActions}>
        {onClear && !isParked && (
          <button
            className={styles.rowAction}
            onClick={handleClear}
            title="Mark read"
            aria-label="Mark read"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 8.5 6.5 12 13 4" />
            </svg>
          </button>
        )}
        {onSetReview && !isParked && (
          <button
            className={styles.rowAction}
            onClick={openPark}
            title="Park — set aside with an optional reason"
            aria-label="Park"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5.5 3.5v9M10.5 3.5v9" />
            </svg>
          </button>
        )}
        {onSetReview && isParked && (
          <button
            className={styles.rowAction}
            onClick={unpark}
            title="Un-park"
            aria-label="Un-park"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a5 5 0 1 1 1.7 3.8" />
              <polyline points="2.5 4.5 3 8 6.5 7.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}, rowPropsEqual);

/**
 * `buildQueue` mints a fresh QueueItem every snapshot tick, so the default
 * shallow compare would never hit. Compare the fields the row actually paints.
 */
function rowPropsEqual(a: QueueRowProps, b: QueueRowProps): boolean {
  return (
    a.now === b.now &&
    a.showChip === b.showChip &&
    a.selected === b.selected &&
    a.onSelect === b.onSelect &&
    a.onClear === b.onClear &&
    a.onSetReview === b.onSetReview &&
    a.item.key === b.item.key &&
    a.item.bucket === b.item.bucket &&
    a.item.liveBucket === b.item.liveBucket &&
    a.item.name === b.item.name &&
    a.item.roomName === b.item.roomName &&
    a.item.activityAt === b.item.activityAt &&
    a.item.detail === b.item.detail &&
    a.item.session.color === b.item.session.color &&
    a.item.session.review === b.item.session.review &&
    a.item.session.parkReason === b.item.session.parkReason &&
    a.item.session.scheduledWakeupAt === b.item.session.scheduledWakeupAt &&
    (a.item.session.backgroundTasks?.length ?? 0) === (b.item.session.backgroundTasks?.length ?? 0) &&
    a.item.session.backgroundTasks?.[0]?.toolUseId === b.item.session.backgroundTasks?.[0]?.toolUseId &&
    a.item.session.sessionId === b.item.session.sessionId
  );
}

export const QueueRail = memo(function QueueRail({
  snapshot,
  customNames,
  onSelectSession,
  onSetReview,
  onToggleRead,
  selectedSessionId,
  onWidthChange,
}: QueueRailProps) {
  const { open, mode, sort, toggleOpen, toggleMode, toggleSort } = useQueueRailState();

  // App re-creates these handlers every render; route them through a ref so the
  // row-level memo actually holds across snapshot ticks.
  const cbRef = useRef({ onSelectSession, onSetReview, onToggleRead });
  cbRef.current = { onSelectSession, onSetReview, onToggleRead };

  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Set<QueueBucketId>>(
    () => new Set(QUEUE_BUCKETS.filter(b => !b.defaultExpanded).map(b => b.id)),
  );

  // One ticker for the whole rail — never one per row.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    onWidthChange?.(open ? RAIL_WIDTH : STRIP_WIDTH);
  }, [open, onWidthChange]);

  const queue = useMemo(
    () => buildQueue(snapshot?.rooms ?? [], customNames, sort),
    [snapshot?.rooms, customNames, sort],
  );

  const toggleBucket = useCallback((id: QueueBucketId) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback((session: Session) => { cbRef.current.onSelectSession(session); }, []);
  const handleRead = useCallback((sessionId: string) => { cbRef.current.onToggleRead?.(sessionId); }, []);
  const handleReview = useCallback(
    (sessionId: string, review: SessionReview | null, reason?: string) => {
      cbRef.current.onSetReview?.(sessionId, review, reason);
    },
    [],
  );

  const clearFor = useCallback((bucket: QueueBucketId): ((sessionId: string) => void) | undefined =>
    READ_BUCKETS.has(bucket) ? handleRead : undefined, [handleRead]);

  if (!open) {
    return (
      <button
        className={styles.strip}
        onClick={toggleOpen}
        title="Open inbox"
        aria-label={`Open inbox — ${queue.badgeCount} awaiting`}
        aria-expanded={false}
      >
        {queue.badgeCount > 0 && <span className={styles.stripBadge}>{queue.badgeCount}</span>}
        <span className={styles.stripLabel}>INBOX</span>
      </button>
    );
  }

  const isEmpty = queue.groups.length === 0;

  return (
    <aside className={styles.rail} aria-label="Inbox — agents awaiting input">
      <div className={styles.header}>
        <span className={styles.title}>INBOX</span>
        <span className={`${styles.badge} ${queue.badgeCount === 0 ? styles.badgeQuiet : ''}`}>{queue.badgeCount}</span>
        <button
          className={`${styles.headerBtn} ${mode === 'flat' ? styles.headerBtnOn : ''}`}
          onClick={toggleMode}
          title={mode === 'grouped' ? 'Switch to flat by time' : 'Switch to grouped by reason'}
          aria-label="Toggle grouping"
          aria-pressed={mode === 'flat'}
        >
          {mode === 'grouped' ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M4 8h10M4 12h10" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 5v3l2 1.4" />
            </svg>
          )}
        </button>
        <button
          className={styles.headerBtn}
          onClick={toggleSort}
          title={sort === 'oldest' ? 'Oldest first — click for newest first' : 'Newest first — click for oldest first'}
          aria-label="Toggle sort direction"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {sort === 'oldest' ? (
              <><path d="M5 3v10" /><path d="M2.5 10.5L5 13l2.5-2.5" /><path d="M9.5 4.5h5M9.5 8h4M9.5 11.5h2.5" /></>
            ) : (
              <><path d="M5 13V3" /><path d="M2.5 5.5L5 3l2.5 2.5" /><path d="M9.5 4.5h2.5M9.5 8h4M9.5 11.5h5" /></>
            )}
          </svg>
        </button>
        <button className={styles.headerBtn} onClick={toggleOpen} title="Collapse inbox" aria-label="Collapse inbox">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M9.5 3.5L5 8l4.5 4.5" />
          </svg>
        </button>
      </div>

      <div className={styles.list}>
        {isEmpty ? (
          <div className={styles.empty}>Nothing waiting on you</div>
        ) : mode === 'flat' ? (
          queue.flat.map(item => (
            <QueueRow
              key={item.key}
              item={item}
              now={now}
              showChip
              selected={selectedSessionId === item.key || selectedSessionId === item.session.sessionId}
              onSelect={handleSelect}
              onClear={clearFor(item.bucket)}
              onSetReview={handleReview}
            />
          ))
        ) : (
          queue.groups.map(group => {
            const isCollapsed = collapsed.has(group.meta.id);
            return (
              <section key={group.meta.id} className={styles.section}>
                <button
                  className={styles.sectionHeader}
                  onClick={() => toggleBucket(group.meta.id)}
                  aria-expanded={!isCollapsed}
                >
                  <Caret open={!isCollapsed} />
                  <span className={styles.sectionLabel}>{group.meta.label}</span>
                  <span className={styles.sectionCount}>{group.items.length}</span>
                </button>
                {!isCollapsed && group.items.map(item => (
                  <QueueRow
                    key={item.key}
                    item={item}
                    now={now}
                    showChip={false}
                    selected={selectedSessionId === item.key || selectedSessionId === item.session.sessionId}
                    onSelect={handleSelect}
                    onClear={clearFor(item.bucket)}
                    onSetReview={handleReview}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>

      <div className={styles.footer}>
        {queue.workingCount > 0 ? `${queue.workingCount} working` : 'nothing running'}
      </div>
    </aside>
  );
});
