import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { WorkerState, Session, ActiveMonitor } from '../types';
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
  completionHint?: 'done' | 'awaiting';
  userAccepted?: boolean;
  acknowledged?: boolean;
  needsPermission?: boolean;
  isCompacting?: boolean;
  bridgeDead?: boolean;
  latestPlan?: { artifactId: string; title: string; body: string; status: string; claudePlanToolUseId?: string; updatedAt: string; };
  isWorker?: boolean;
  isRaw?: boolean;
  ptyInputPendingSince?: number;
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
  completionHint?: 'done' | 'awaiting';
  userAccepted?: boolean;
  acknowledged?: boolean;
  needsPermission?: boolean;
  styles: Record<string, string>;
}

function WaitingIndicator({ isSubagent, completionHint, userAccepted, acknowledged, needsPermission, styles }: WaitingIndicatorProps) {
  if (isSubagent) return <span className={styles.subagentDoneCheck}>✓</span>;
  if (userAccepted) {
    return <span className={styles.bubbleDone}>done</span>;
  }
  if (completionHint === 'done') {
    return <span className={styles.bubbleDonePending}>review</span>;
  }
  if (needsPermission) return <span className={styles.bubblePermission}>needs approval</span>;
  if (acknowledged) return null;
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


export const Worker = memo(function Worker({ sessionId, name, state, color, provider, isSubagent, minimal, agentType, completionHint, userAccepted, acknowledged, needsPermission, isCompacting, bridgeDead, latestPlan: latestPlanProp, isWorker, isRaw, ptyInputPendingSince, notesSummary, intent, activeMonitors, jiraKeys, jiraBaseUrl, onClick, onRename, roomPrefix }: WorkerProps) {
  const displayColor = isSubagent ? lightenHsl(color, 20) : color;
  const highlightColor = lightenHsl(displayColor, 25);
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

  const isDone = (state === 'waiting' || state === 'closed') && completionHint === 'done';
  const stateClass = `${styles[state] ?? ''}${isDone ? ' ' + styles.done : ''}`;

  const latestPlan = isSubagent ? null : (latestPlanProp ?? null);

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
      {!minimal && bridgeDead && !isSubagent && (
        <div className={styles.bridgeDeadBadge}>bridge lost</div>
      )}
      {!minimal && (isCompacting || state === 'working' || state === 'thinking' || state === 'waiting' || (state === 'closed' && (userAccepted || completionHint === 'done'))) && !(!isCompacting && state === 'waiting' && acknowledged && !userAccepted && !needsPermission) && (
        <div
          className={`${styles.indicator} ${isCompacting ? styles.indicator_compacting : styles[`indicator_${state}`]} ${isSubagent ? styles.indicatorSubagent : ''}`}
          onClick={!isSubagent && !userAccepted && !needsPermission ? handleIndicatorClick : undefined}
          style={!isSubagent && !userAccepted && !needsPermission ? { cursor: 'pointer' } : undefined}
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
                  completionHint={completionHint}
                  userAccepted={userAccepted}
                  acknowledged={acknowledged}
                  needsPermission={needsPermission}
                  styles={styles}
                />
              )}
              {state === 'closed' && (userAccepted || completionHint === 'done') && (
                <span className={userAccepted ? styles.bubbleDone : styles.bubbleDonePending}>closed · {userAccepted ? 'done' : 'review'}</span>
              )}
            </>
          )}
        </div>
      )}
      {isRaw ? (
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
      )}

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
          planContent={latestPlan.body}
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
  );
});
