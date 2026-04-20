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
      return parts.length > 0 ? parts.join(' — ') : m.toolUseId.slice(0, 8);
    })
    .join('\n');

  const label = monitors.length > 1 ? `Monitoring ×${monitors.length}` : 'Monitoring';

  return (
    <span className={styles.pill} title={tooltip}>
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
