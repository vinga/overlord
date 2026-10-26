import React from 'react';
import type { BackgroundTask, BackgroundProgress } from '../types';
import { formatElapsed } from '../lib/formatElapsed';
import { useTick } from '../hooks/useTick';
import styles from './MonitoringPill.module.css';

interface Props {
  tasks: BackgroundTask[];
  progress?: BackgroundProgress[];
}

/** Progress summary for a task. Pinned to the first unfinished row in first-seen
 *  order — never "the newest row": with several rows updating at different
 *  rates that label would flip between them on every line and flicker. */
function progressText(card: BackgroundProgress | undefined): string | undefined {
  if (!card) return undefined;
  if (card.rows.length === 0) return card.lastLine;
  const row = card.rows.find(r => !r.final) ?? card.rows[0];
  const step = row.step !== undefined ? `${row.step}${row.max ? `/${row.max}` : ''}` : '';
  const text = [card.rows.length > 1 ? (row.label ?? row.id) : '', step, row.state ?? row.message].filter(Boolean).join(' ');
  if (card.rows.length === 1) return text;
  const done = card.rows.filter(r => r.final).length;
  return `${done}/${card.rows.length} done · ${text}`;
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
      return `${t.description ?? 'Background command'}${elapsed ? ` — ${elapsed}` : ''}${latest ? `\n  ${latest}` : ''}`;
    })
    .join('\n');

  // CSS ellipsis trims the description to the card width.
  const first = tasks[0];
  const latest = progressText(cardFor(first));
  const label = tasks.length > 1
    ? `Background ×${tasks.length}`
    : `Background · ${latest ?? first.description ?? 'command'}`;

  return (
    <span className={`${styles.pill} ${styles.background}`} title={tooltip}>
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
