import React, { memo } from 'react';
import type { WorkerState } from '../types';
import styles from './Worker.module.css';

interface WorkerProps {
  sessionId: string;
  name?: string;
  state: WorkerState;
  color: string;
  isSubagent?: boolean;
  minimal?: boolean;
  agentType?: string;
  completionHint?: 'done' | 'awaiting';
  completionSummaries?: Array<{ summary: string; completedAt: string }>;
  userAccepted?: boolean;
  needsPermission?: boolean;
  currentTaskLabel?: string;
  isWorker?: boolean;
  onClick: () => void;
}

interface WaitingIndicatorProps {
  isSubagent: boolean;
  completionHint?: 'done' | 'awaiting';
  userAccepted?: boolean;
  needsPermission?: boolean;
  styles: Record<string, string>;
}

function WaitingIndicator({ isSubagent, completionHint, userAccepted, needsPermission, styles }: WaitingIndicatorProps) {
  if (isSubagent) return <span className={styles.subagentDoneCheck}>✓</span>;
  if (completionHint === 'done') {
    return userAccepted
      ? <span className={styles.bubbleDone}>done</span>
      : <span className={styles.bubbleDonePending}>review</span>;
  }
  if (needsPermission) return <span className={styles.bubblePermission}>needs approval</span>;
  return <span className={styles.bubble}>waiting</span>;
}

function lightenHsl(color: string, amount: number): string {
  const match = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!match) return color;
  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]);
  const l = Math.min(100, parseFloat(match[3]) + amount);
  return `hsl(${h}, ${s}%, ${l}%)`;
}


export const Worker = memo(function Worker({ sessionId, name, state, color, isSubagent, minimal, agentType, completionHint, completionSummaries, userAccepted, needsPermission, currentTaskLabel, isWorker, onClick }: WorkerProps) {
  const displayColor = isSubagent ? lightenHsl(color, 20) : color;
  const highlightColor = lightenHsl(displayColor, 25);
  const label = isWorker ? 'AI Worker' : (isSubagent && agentType ? agentType : (name ?? sessionId.slice(0, 8)));

  const isDone = state === 'waiting' && completionHint === 'done';
  const stateClass = `${styles[state] ?? ''}${isDone ? ' ' + styles.done : ''}`;

  return (
    <div
      className={`${styles.worker} ${stateClass}`}
      style={{ '--agent-color': displayColor } as React.CSSProperties}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      aria-label={`Worker ${label}`}
    >
      {!minimal && needsPermission && !isSubagent && (
        <div className={styles.permissionBadge}>⚠ approval</div>
      )}
      {!minimal && (state === 'working' || state === 'thinking' || state === 'waiting') && (
        <div className={`${styles.indicator} ${styles[`indicator_${state}`]} ${isSubagent ? styles.indicatorSubagent : ''}`}>
          {state === 'working' && (
            <span className={styles.workingDot} />
          )}
          {state === 'thinking' && (
            <span className={styles.dots}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </span>
          )}
          {state === 'waiting' && (
            <WaitingIndicator
              isSubagent={!!isSubagent}
              completionHint={completionHint}
              userAccepted={userAccepted}
              needsPermission={needsPermission}
              styles={styles}
            />
          )}
        </div>
      )}
      <svg
        width="88"
        height="115"
        viewBox="0 0 40 52"
        xmlns="http://www.w3.org/2000/svg"
        className={styles.svg}
      >
        <defs>
          <linearGradient id={`grad-${sessionId}`} x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor={highlightColor} />
            <stop offset="100%" stopColor={displayColor} />
          </linearGradient>
        </defs>
        {/* Head */}
        <circle cx="20" cy="12" r="10" fill={`url(#grad-${sessionId})`} />
        {/* Eyes */}
        <circle cx="16" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
        <circle cx="24" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
        {/* Body */}
        <rect x="10" y="24" width="20" height="22" rx="3" fill={`url(#grad-${sessionId})`} />
        {/* Arms */}
        <rect x="2" y="24" width="7" height="14" rx="2" fill={displayColor} />
        <rect x="31" y="24" width="7" height="14" rx="2" fill={displayColor} />
        {/* Legs */}
        <rect x="11" y="46" width="7" height="6" rx="2" fill={displayColor} />
        <rect x="22" y="46" width="7" height="6" rx="2" fill={displayColor} />
      </svg>

      {!minimal && (
        <span className={`${styles.label} ${isSubagent ? styles.labelSubagent : ''}`}>{label}</span>
      )}
      {!minimal && !isSubagent && currentTaskLabel && (state === 'working' || state === 'thinking') && (
        <span className={styles.activeTaskLabel}>{currentTaskLabel}</span>
      )}
      {!minimal && completionSummaries && completionSummaries.length > 0 && completionHint === 'done' && !isSubagent && (
        <span className={styles.completionSummary}>{completionSummaries[completionSummaries.length - 1].summary}</span>
      )}
    </div>
  );
});
