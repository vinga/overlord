import React, { useState, useEffect, useCallback } from 'react';
import styles from './ScheduledWakeupsStats.module.css';

interface WakeupInfo {
  scheduledAt?: string;
  fireAt?: number;
  delaySeconds?: number;
  reason?: string;
  prompt?: string;
  status: 'pending' | 'fired' | 'stopped' | 'superseded' | 'unconfirmed';
}

function fmtTime(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL: Record<WakeupInfo['status'], string> = {
  pending: 'pending',
  fired: 'fired',
  stopped: 'stopped',
  superseded: 'superseded',
  unconfirmed: 'unconfirmed',
};

interface Props {
  sessionId: string;
  nextFireAt: number;
  /** From the snapshot — shown collapsed, so the "why" needs no fetch. */
  reason?: string;
}

/** ScheduleWakeup panel: collapsed by default showing only the active wakeup
 *  (time + reason). Expanding fetches the full history lazily from
 *  GET /api/sessions/:sessionId/scheduled-wakeups — never on the WS tick. */
export function ScheduledWakeupsStats({ sessionId, nextFireAt, reason }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<WakeupInfo[] | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${sessionId}/scheduled-wakeups`);
        const d = await r.json() as { wakeups?: WakeupInfo[] };
        if (!cancelled) setItems(d.wakeups ?? []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
    // nextFireAt in deps: a re-schedule refreshes the list while open.
  }, [expanded, sessionId, nextFireAt]);

  const toggle = useCallback(() => setExpanded(v => !v), []);

  return (
    <div className={styles.wrap}>
      <button className={styles.header} onClick={toggle} aria-expanded={expanded}>
        <svg className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" className={styles.clock}>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M 6 3.2 L 6 6 L 8 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={styles.headerTime}>{fmtTime(nextFireAt)}</span>
        <span className={styles.headerReason} title={reason}>{reason ?? 'Scheduled wakeup'}</span>
      </button>
      {expanded && (
        <div className={styles.list}>
          {items === null && <div className={styles.loading}>Loading…</div>}
          {items !== null && items.length === 0 && <div className={styles.loading}>No wakeups recorded.</div>}
          {items?.map((w, i) => (
            <div key={i} className={styles.entry}>
              <div className={styles.row}>
                <span className={`${styles.chip} ${styles[`chip_${w.status}`] ?? ''}`}>{STATUS_LABEL[w.status]}</span>
                <span className={styles.time}>{fmtTime(w.fireAt)}</span>
                <span className={styles.reason} title={w.reason}>{w.reason ?? (w.status === 'stopped' ? 'Loop stopped' : '')}</span>
              </div>
              {w.prompt && <div className={styles.prompt} title={w.prompt}>{w.prompt}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
