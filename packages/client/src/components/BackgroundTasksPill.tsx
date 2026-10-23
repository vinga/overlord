import React from 'react';
import type { BackgroundTask, BackgroundProgress } from '../types';
import { formatElapsed } from '../lib/formatElapsed';
import { useTick } from '../hooks/useTick';
import styles from './MonitoringPill.module.css';

interface Props {
  tasks: BackgroundTask[];
  progress?: BackgroundProgress[];
}

/** Latest progress for a task: its newest `::progress::` row, else its last raw line. */
function progressText(card: BackgroundProgress | undefined): string | undefined {
  if (!card) return undefined;
  const row = card.rows.reduce<BackgroundProgress['rows'][number] | undefined>((a, r) => (!a || r.at >= a.at ? r : a), undefined);
  if (!row) return card.lastLine;
  const step = row.step !== undefined ? `${row.step}${row.max ? `/${row.max}` : ''}` : '';
  return [card.rows.length > 1 ? (row.label ?? row.id) : '', step, row.state ?? row.message].filter(Boolean).join(' ');
}

/** Sibling of MonitoringPill for `Bash(run_in_background: true)` commands: names
 *  what is running on the card itself, in every state — the waiting bubble only
 *  carries the elapsed time, and only while the session is idle. */
export function BackgroundTasksPill({ tasks, progress }: Props) {
  const hasTasks = tasks != null && tasks.length > 0;
  // Elapsed drifts without a WS tick on an idle session.
  useTick(hasTasks ? 60_000 : null);
  if (!hasTasks) return null;

  const cardFor = (t: BackgroundTask) => progress?.find(p => p.toolUseId === t.toolUseId);
  const tooltip = tasks
    .map(t => {
      const elapsed = formatElapsed(t.startedAt);
      const latest = progressText(cardFor(t));
      return `${t.description ?? t.taskId}${elapsed ? ` — ${elapsed}` : ''}${latest ? `\n  ${latest}` : ''}`;
    })
    .join('\n');

  // CSS ellipsis trims the description to the card width.
  const first = tasks[0];
  const latest = progressText(cardFor(first));
  const label = tasks.length > 1
    ? `Background ×${tasks.length}`
    : `Background · ${latest ?? first.description ?? first.taskId}`;

  return (
    <span className={`${styles.pill} ${styles.background}`} title={tooltip}>
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
