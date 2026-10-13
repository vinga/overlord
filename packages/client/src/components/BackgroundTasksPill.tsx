import React from 'react';
import type { BackgroundTask } from '../types';
import { formatElapsed } from '../lib/formatElapsed';
import { useTick } from '../hooks/useTick';
import styles from './MonitoringPill.module.css';

interface Props {
  tasks: BackgroundTask[];
}

/** Sibling of MonitoringPill for `Bash(run_in_background: true)` commands: names
 *  what is running on the card itself, in every state — the waiting bubble only
 *  carries the elapsed time, and only while the session is idle. */
export function BackgroundTasksPill({ tasks }: Props) {
  const hasTasks = tasks != null && tasks.length > 0;
  // Elapsed drifts without a WS tick on an idle session.
  useTick(hasTasks ? 60_000 : null);
  if (!hasTasks) return null;

  const tooltip = tasks
    .map(t => {
      const elapsed = formatElapsed(t.startedAt);
      return `${t.description ?? t.taskId}${elapsed ? ` — ${elapsed}` : ''}`;
    })
    .join('\n');

  // CSS ellipsis trims the description to the card width.
  const label = tasks.length > 1
    ? `Background ×${tasks.length}`
    : `Background · ${tasks[0].description ?? tasks[0].taskId}`;

  return (
    <span className={`${styles.pill} ${styles.background}`} title={tooltip}>
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
