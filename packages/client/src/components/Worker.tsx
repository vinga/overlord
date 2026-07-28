import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { WorkerState, Session, ActiveMonitor, BackgroundTask, WorkerIcon, SessionReview } from '../types';
import { formatElapsed } from '../lib/queueBuckets';
import { WorkerGlyph } from './workerGlyphs';
import styles from './Worker.module.css';
import { WorkerArtifactPill } from './WorkerArtifactPill';
import { MonitoringPill } from './MonitoringPill';
import { JiraChips } from './JiraChips';
import { selectAfterPrefix } from '../hooks/useRoomPrefix';

interface WorkerProps {
  sessionId: string;
  name?: string;
  state: WorkerState;
  color: string;
  provider?: Session['provider'];
  isSubagent?: boolean;
  minimal?: boolean;
  agentType?: string;
  review?: SessionReview;
  parkReason?: string;
  needsPermission?: boolean;
  unknownCommand?: string;
  isCompacting?: boolean;
  bridgeDead?: boolean;
  /** Metadata only — the plan `body` is fetched on demand via GET /api/artifacts/:artifactId. */
  latestPlan?: { artifactId: string; title: string; status: string; claudePlanToolUseId?: string; updatedAt: string; };
  isWorker?: boolean;
  isRaw?: boolean;
  icon?: WorkerIcon;
  ptyInputPendingSince?: number;
  scheduledWakeupAt?: number;
  backgroundTasks?: BackgroundTask[];
  notesSummary?: string;
  intent?: string;
  activeMonitors?: ActiveMonitor[];
  jiraKeys?: string[];
  jiraBaseUrl?: string;
  onClick: () => void;
  onRename?: (newName: string) => void;
  roomPrefix?: string;
}

interface WaitingIndicatorProps {
  isSubagent: boolean;
  review?: SessionReview;
  needsPermission?: boolean;
  unknownCommand?: string;
  scheduledWakeupAt?: number;
  backgroundTasks?: BackgroundTask[];
  styles: Record<string, string>;
}

function WaitingIndicator({ isSubagent, review, needsPermission, unknownCommand, scheduledWakeupAt, backgroundTasks, styles }: WaitingIndicatorProps) {
  if (isSubagent) return <span className={styles.subagentDoneCheck}>✓</span>;
  if (needsPermission) return <span className={styles.bubblePermission}>needs approval</span>;
  // Fresh event — show it even if the "waiting" bubble was acknowledged.
  if (unknownCommand) return <span className={styles.bubbleUnknownCmd}>⚠ {unknownCommand} not a command</span>;
  // Self-scheduled wakeup pending — the session is idle on purpose, not blocked
  // on the user. Static (no pulse): informational, not a call to action.
  // Shown regardless of ack (replaces "waiting").
  if (scheduledWakeupAt) {
    const fireTime = new Date(scheduledWakeupAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
      <span className={styles.bubbleScheduled} title={`Scheduled wakeup at ${fireTime}`}>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M 6 3.2 L 6 6 L 8 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {fireTime}
      </span>
    );
  }
  // Background command still running — the harness re-invokes on exit, so this is
  // a machine wait, not a user wait. No fire time exists: show elapsed instead.
  // Same static treatment as scheduled, and likewise shown regardless of ack.
  if (backgroundTasks && backgroundTasks.length > 0) {
    const first = backgroundTasks[0];
    const elapsed = formatElapsed(first.startedAt);
    const extra = backgroundTasks.length > 1 ? ` +${backgroundTasks.length - 1}` : '';
    const label = first.description ?? first.taskId;
    return (
      <span className={styles.bubbleBackground} title={`Running in background: ${label}${elapsed ? ` (${elapsed})` : ''}`}>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3.5 2.5" />
        </svg>
        {elapsed || 'running'}{extra}
      </span>
    );
  }
  // Both markers silence the pulsing bubble; parked also paints its own chip.
  if (review != null) return null;
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


export const Worker = memo(function Worker({ sessionId, name, state, color, provider, isSubagent, minimal, agentType, review, parkReason, needsPermission, unknownCommand, isCompacting, bridgeDead, latestPlan: latestPlanProp, isWorker, isRaw, icon, ptyInputPendingSince, scheduledWakeupAt, backgroundTasks, notesSummary, intent, activeMonitors, jiraKeys, jiraBaseUrl, onClick, onRename, roomPrefix }: WorkerProps) {
  const displayColor = isSubagent ? lightenHsl(color, 20) : color;
  const highlightColor = lightenHsl(displayColor, 25);
  // An explicitly picked glyph overrides the raw terminal variant.
  const glyph: WorkerIcon = icon ?? 'user';
  const label = isWorker ? 'AI Worker' : (isSubagent && agentType ? agentType : (name ?? sessionId.slice(0, 8)));

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      selectAfterPrefix(inputRef.current, roomPrefix ?? '');
    }
  }, [isEditing, roomPrefix]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label && onRename) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, label, onRename]);

  const handleIndicatorClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void fetch(`/api/sessions/${sessionId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  }, [sessionId]);

  const handleLabelDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!onRename || isSubagent) return;
    e.stopPropagation();
    e.preventDefault();
    setEditValue(label);
    setIsEditing(true);
  }, [onRename, isSubagent, label]);

  const isScheduled = state === 'waiting' && scheduledWakeupAt != null && !needsPermission;
  const hasBackgroundTasks = backgroundTasks != null && backgroundTasks.length > 0;
  const isBackground = state === 'waiting' && hasBackgroundTasks && !isScheduled && !needsPermission;
  const stateClass = `${styles[state] ?? ''}${isScheduled ? ' ' + styles.scheduled : ''}${isBackground ? ' ' + styles.background : ''}`;

  const latestPlan = isSubagent ? null : (latestPlanProp ?? null);
  // Full workers lay out icon-left / text-right; subagents and minimal chips stay stacked.
  const horizontal = !minimal && !isSubagent;

  return (
    <div
      className={`${styles.worker} ${horizontal ? styles.horizontal : ''} ${stateClass}`}
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
      {!minimal && bridgeDead && !isSubagent && (
        <div className={styles.bridgeDeadBadge}>bridge lost</div>
      )}
      {/* Parked is sticky across every state, so it gets its own chip rather than
          riding on the waiting indicator. */}
      {!minimal && review === 'parked' && !isSubagent && (
        <div className={styles.parkedBadge} title={parkReason ? `Parked · ${parkReason}` : 'Parked'}>
          ⏸ parked
        </div>
      )}
      {!minimal && (isCompacting || state === 'working' || state === 'thinking' || state === 'waiting') && !(!isCompacting && state === 'waiting' && review != null && !needsPermission && !unknownCommand && !scheduledWakeupAt && !hasBackgroundTasks) && (
        <div
          className={`${styles.indicator} ${isCompacting ? styles.indicator_compacting : styles[`indicator_${state}`]} ${isSubagent ? styles.indicatorSubagent : ''}`}
          onClick={!isSubagent && !needsPermission ? handleIndicatorClick : undefined}
          style={!isSubagent && !needsPermission ? { cursor: 'pointer' } : undefined}
        >
          {isCompacting ? (
            <span className={styles.bubbleCompacting}>compacting</span>
          ) : (
            <>
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
                  review={review}
                  needsPermission={needsPermission}
                  unknownCommand={unknownCommand}
                  scheduledWakeupAt={scheduledWakeupAt}
                  backgroundTasks={backgroundTasks}
                  styles={styles}
                />
              )}
            </>
          )}
        </div>
      )}
      <div className={styles.body}>
      <div className={styles.iconWrap}>
      {isRaw && glyph === 'user' ? (
        <svg
          width="48"
          height="63"
          viewBox="0 0 48 63"
          xmlns="http://www.w3.org/2000/svg"
          className={styles.svg}
        >
          <defs>
            <linearGradient id={`grad-${sessionId}`} x1="0%" y1="0%" x2="60%" y2="100%">
              <stop offset="0%" stopColor={highlightColor} />
              <stop offset="100%" stopColor={displayColor} />
            </linearGradient>
          </defs>
          {/* Terminal window — centered vertically in 63px box */}
          <g transform="translate(1, 14.5)">
            <rect x="0" y="0" width="46" height="34" rx="4" fill={`url(#grad-${sessionId})`} />
            {/* Title bar */}
            <rect x="0" y="0" width="46" height="8" rx="4" fill="rgba(0,0,0,0.28)" />
            {/* Traffic lights */}
            <circle cx="5.5" cy="4.5" r="1.5" fill="rgba(255,255,255,0.55)" />
            <circle cx="10.5" cy="4.5" r="1.5" fill="rgba(255,255,255,0.35)" />
            <circle cx="15.5" cy="4.5" r="1.5" fill="rgba(255,255,255,0.2)" />
            {/* Prompt chevron */}
            <path d="M 8 15 L 14 21 L 8 27" stroke="rgba(255,255,255,0.92)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            {/* Cursor underscore */}
            <rect x="18" y="25" width="14" height="2.2" rx="1" fill="rgba(255,255,255,0.92)" />
          </g>
        </svg>
      ) : (
        <svg
          width="48"
          height="63"
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
          <WorkerGlyph icon={glyph} gradientUrl={`url(#grad-${sessionId})`} color={displayColor} />
        </svg>
      )}
      </div>

      <div className={styles.content}>
      {!minimal && (
        isEditing ? (
          <input
            ref={inputRef}
            className={styles.labelEdit}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setIsEditing(false); setEditValue(label); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className={`${styles.label} ${isSubagent ? styles.labelSubagent : ''}`}
            onDoubleClick={handleLabelDoubleClick}
          >
            {label}
          </span>
        )
      )}
      {!minimal && !isSubagent && notesSummary && (
        <span className={styles.notesSummaryLine}><span className={styles.notesSummaryPrefix}>Notes:</span> {notesSummary}</span>
      )}
      {!minimal && !isSubagent && intent && (
        <span className={`${styles.requestSummary} ${state === 'closed' ? styles.intentDone : ''}`}>
          <span className={styles.notesSummaryPrefix}>Intent:</span> {intent}
        </span>
      )}
      {!minimal && latestPlan && (
        <WorkerArtifactPill
          artifactId={latestPlan.artifactId}
          title={latestPlan.title ?? 'Plan'}
          planStatus={latestPlan.status as 'draft' | 'active' | 'done' | 'archived'}
          timestamp={latestPlan.updatedAt}
        />
      )}
      {!minimal && !isSubagent && jiraKeys && jiraKeys.length > 0 && (
        <JiraChips keys={jiraKeys} baseUrl={jiraBaseUrl} sessionId={sessionId} />
      )}
      {!minimal && !isSubagent && activeMonitors && activeMonitors.length > 0 && (
        <MonitoringPill monitors={activeMonitors} />
      )}
      </div>
      </div>
    </div>
  );
});
