import React from 'react';
import type { ActiveMonitor } from '../types';
import styles from './MonitoringPill.module.css';

interface Props {
  monitors: ActiveMonitor[];
}

export function MonitoringPill({ monitors }: Props) {
  if (!monitors || monitors.length === 0) return null;

  const tooltip = monitors
    .map(m => {
      const parts: string[] = [];
      if (m.target) parts.push(m.target);
      if (m.until) parts.push(`until: ${m.until}`);
      if (m.expiresAt) parts.push(`expires ${new Date(m.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      const head = parts.length > 0 ? parts.join(' — ') : m.toolUseId.slice(0, 8);
      // Newest event under the header so a hover answers "what did it last see".
      return m.lastEvent ? `${head}\n  ↳ ${m.lastEvent.replace(/\s+/g, ' ').slice(0, 160)}` : head;
    })
    .join('\n');

  // One harness monitor: name the watch on the pill itself; several: count them.
  const single = monitors.length === 1 && monitors[0].taskId ? monitors[0].target : '';
  const label = monitors.length > 1
    ? `Monitoring ×${monitors.length}`
    : single ? `Monitoring · ${single.length > 28 ? single.slice(0, 27) + '…' : single}` : 'Monitoring';

  return (
    <span className={styles.pill} title={tooltip}>
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
