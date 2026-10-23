import React, { useCallback, useEffect, useState } from 'react';
import type { BackgroundProgress, ProgressHistoryEntry, ProgressRow } from '../types';
import { formatElapsed } from '../lib/formatElapsed';
import { useTick } from '../hooks/useTick';
import styles from './ProgressCard.module.css';

interface Props {
  card: BackgroundProgress;
  sessionId: string;
}

const STATUS_LABEL: Record<BackgroundProgress['status'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function rowPct(row: ProgressRow): number | undefined {
  if (row.pct !== undefined) return row.pct;
  if (row.step !== undefined && row.max) return Math.min(100, (row.step / row.max) * 100);
  return undefined;
}

function rowTone(row: ProgressRow, cardStatus: BackgroundProgress['status']): string {
  if (row.final === 'fail') return styles.toneFail;
  if (row.final === 'done') return styles.toneDone;
  if (row.final === 'stopped' || cardStatus === 'stopped') return styles.toneStopped;
  return styles.toneRunning;
}

/** Live card for a `Bash(run_in_background)` command, rendered in the chat feed
 *  under the tool call that launched it. Data comes from the server reading the
 *  command's output file — the agent spends no tokens on it. */
export function ProgressCard({ card, sessionId }: Props) {
  const running = card.status === 'running';
  // Elapsed drifts between output lines.
  useTick(running ? 1000 : null);
  const [history, setHistory] = useState<ProgressHistoryEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(() => setOpen(o => !o), []);

  // Refetch while open whenever a new line lands, so the history stays live.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/progress/${encodeURIComponent(card.toolUseId)}`)
      .then(r => (r.ok ? r.json() : { entries: [] }))
      .then((d: { entries: ProgressHistoryEntry[] }) => { if (!cancelled) setHistory(d.entries); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, sessionId, card.toolUseId, card.lineCount]);

  const elapsed = card.startedAt
    ? formatElapsed(card.startedAt, card.endedAt ?? Date.now())
    : '';
  const title = card.rows.length === 1 && card.rows[0].label ? card.rows[0].label : (card.description ?? card.taskId);
  const lines = history?.filter((e): e is Extract<ProgressHistoryEntry, { t: 'line' }> => e.t === 'line') ?? [];

  return (
    <div className={`${styles.card} ${styles[card.status]}`} data-progress-card={card.toolUseId}>
      <div className={styles.header}>
        <span className={styles.statusDot} />
        <span className={styles.title} title={card.description}>{title}</span>
        <span className={styles.statusChip}>{STATUS_LABEL[card.status]}</span>
        {elapsed && <span className={styles.meta}>{elapsed}</span>}
      </div>

      {card.rows.length > 0 && (
        <div className={styles.rows}>
          {card.rows.map(row => {
            const pct = rowPct(row);
            return (
              <div key={row.id} className={`${styles.row} ${rowTone(row, card.status)}`}>
                {(card.rows.length > 1 || !row.label) && (
                  <span className={styles.rowLabel}>{row.label ?? row.id}</span>
                )}
                {row.step !== undefined && (
                  <span className={styles.step}>{row.step}{row.max ? `/${row.max}` : ''}</span>
                )}
                {pct !== undefined && (
                  <span className={styles.bar}><span className={styles.barFill} style={{ width: `${pct}%` }} /></span>
                )}
                {row.state && <span className={styles.state}>{row.state}</span>}
                <span className={styles.message} title={row.message}>{row.message}</span>
              </div>
            );
          })}
        </div>
      )}

      {card.lastLine && (
        <div className={styles.lastLine} title={card.lastLine}>{card.lastLine}</div>
      )}
      {card.rows.length === 0 && !card.lastLine && (
        <div className={styles.empty}>{running ? 'No output yet' : 'No output'}</div>
      )}

      {card.lineCount > 0 && (
        <button type="button" className={styles.historyToggle} onClick={toggle}>
          {open ? 'Hide' : 'Show'} history · {card.lineCount} {card.lineCount === 1 ? 'line' : 'lines'}
          {card.lastAt ? ` · last ${clock(card.lastAt)}` : ''}
        </button>
      )}
      {open && (
        <div className={styles.history}>
          {loading && lines.length === 0 && <div className={styles.empty}>Loading…</div>}
          {!loading && lines.length === 0 && <div className={styles.empty}>No saved history</div>}
          {lines.map((e, i) => (
            <div key={i} className={styles.historyLine}>
              <span className={styles.historyTime}>{clock(e.at)}</span>
              {e.row ? (
                <span className={styles.historyText}>
                  <span className={styles.historyId}>{e.row.label ?? e.row.id}</span>
                  {e.row.step !== undefined && ` ${e.row.step}${e.row.max ? `/${e.row.max}` : ''}`}
                  {e.row.state && <span className={styles.historyState}> {e.row.state}</span>}
                  {e.row.message && ` — ${e.row.message}`}
                </span>
              ) : (
                <span className={styles.historyText}>{e.text}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
