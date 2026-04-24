import React, { useState, memo } from 'react';
import type { Session, WorkerState, Subagent } from '../types';
import { Worker } from './Worker';
import { useNotesSummaries } from '../hooks/useNotesSummaries';
import { useRoomPrefix } from '../hooks/useRoomPrefix';
import styles from './WorkerGroup.module.css';

function lightenHsl(color: string, amount: number): string {
  const match = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!match) return color;
  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]);
  const l = Math.min(100, parseFloat(match[3]) + amount);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function SubagentRow({ subagent, color, onClick }: { subagent: Subagent; color: string; onClick: () => void }) {
  const displayColor = lightenHsl(color, 20);
  const highlightColor = lightenHsl(displayColor, 25);
  const label = subagent.description || subagent.agentType || '';
  const state: WorkerState = subagent.state;
  const gradId = `subgrad-${subagent.agentId}`;
  return (
    <div
      className={`${styles.subagentRow} ${styles[`subagentRow_${state}`] ?? ''}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      title={label}
    >
      <span className={styles.subagentIcon}>
        <svg width="20" height="22" viewBox="0 0 40 44" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="60%" y2="100%">
              <stop offset="0%" stopColor={highlightColor} />
              <stop offset="100%" stopColor={displayColor} />
            </linearGradient>
          </defs>
          <circle cx="20" cy="10" r="9" fill={`url(#${gradId})`} />
          <circle cx="16.5" cy="9.5" r="1.7" fill="rgba(0,0,0,0.55)" />
          <circle cx="23.5" cy="9.5" r="1.7" fill="rgba(0,0,0,0.55)" />
          <rect x="11" y="21" width="18" height="18" rx="3" fill={`url(#${gradId})`} />
        </svg>
        {state === 'working' && <span className={styles.subagentDot} />}
        {state === 'thinking' && <span className={`${styles.subagentDot} ${styles.subagentDotThinking}`} />}
        {state === 'waiting' && <span className={styles.subagentCheck}>✓</span>}
      </span>
      <span className={styles.subagentLabel}>{label}</span>
    </div>
  );
}

interface WorkerGroupProps {
  session: Session;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customName?: string;
  onDeleteSession?: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  roomGitBranch?: string;
}

function SessionBranchBadge({ branch, pullRequest }: { branch: string; pullRequest?: Session['pullRequest'] }) {
  const prOpen = pullRequest && pullRequest.state !== 'MERGED' && pullRequest.state !== 'CLOSED';
  return (
    <div className={styles.branchBadge} onClick={e => e.stopPropagation()}>
      <span className={styles.branchBadgePill} title={`Branch: ${branch}`}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="6" r="1.5" />
          <path d="M4 4.5v7" />
          <path d="M12 7.5c0 3-4 2.5-4 5" />
        </svg>
        <span className={styles.branchBadgeText}>{branch}</span>
      </span>
      {pullRequest && (
        <a
          className={`${styles.prPill} ${prOpen ? styles.prPillOpen : styles.prPillClosed} ${pullRequest.isDraft ? styles.prPillDraft : ''}`}
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          title={`#${pullRequest.number} · ${pullRequest.isDraft ? 'Draft' : pullRequest.state}\n${pullRequest.title}`}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4" cy="3" r="1.5" />
            <circle cx="4" cy="13" r="1.5" />
            <circle cx="12" cy="13" r="1.5" />
            <path d="M4 4.5v7" />
            <path d="M12 3v8.5" />
            <path d="M12 3h-2" />
            <path d="M10 1.5L8.5 3 10 4.5" />
          </svg>
          <span>#{pullRequest.number}</span>
        </a>
      )}
    </div>
  );
}

const MAX_VISIBLE_SUBAGENTS = 4;
const STORAGE_KEY = 'overlord:subagentExpanded';

function readExpanded(sessionId: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return map[sessionId] ?? true;
  } catch { return true; }
}

export const WorkerGroup = memo(function WorkerGroup({ session, onSelectSession, customName, onDeleteSession, onRename, roomGitBranch }: WorkerGroupProps) {
  const [expanded] = useState(() => readExpanded(session.sessionId));
  const [overflowExpanded, setOverflowExpanded] = useState(false);
  const notesMap = useNotesSummaries();
  const roomPrefix = useRoomPrefix(session.cwd);

  const allRecentSubagents = session.subagents.filter(s =>
    s.state === 'working' || s.state === 'thinking' ||
    ((s.state === 'waiting' || s.state === 'closed') && Date.now() - new Date(s.lastActivity).getTime() < 7 * 60 * 1000)
  );

  const visibleSubagents = overflowExpanded ? allRecentSubagents : allRecentSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
  const displayName = customName ?? session.proposedName ?? session.slug ?? session.sessionId.slice(0, 8);
  const extraCount = allRecentSubagents.length - MAX_VISIBLE_SUBAGENTS;

  return (
    <div className={styles.group}>
      {/* Main worker */}
      <div className={styles.mainWorker}>
        <Worker
          sessionId={session.sessionId}
          name={displayName}
          state={session.state}
          color={session.color}
          provider={session.provider}
          completionHint={session.completionHint}
          userAccepted={session.userAccepted}
          acknowledged={session.acknowledged}
          needsPermission={session.needsPermission}
          isCompacting={session.isCompacting}
          bridgeDead={session.bridgeDead}
          latestPlan={session.latestPlan}
          isWorker={session.isWorker}
          isRaw={session.sessionType === 'raw'}
          ptyInputPendingSince={session.ptyInputPendingSince}
          notesSummary={notesMap.get(session.sessionId)}
          intent={session.intent}
          activeMonitors={session.activeMonitors}
          onClick={() => onSelectSession(session)}
          onRename={onRename ? (name) => onRename(session.sessionId, name) : undefined}
          roomPrefix={roomPrefix}
        />
        {session.gitBranch && session.gitBranch !== roomGitBranch && (
          <SessionBranchBadge branch={session.gitBranch} pullRequest={session.pullRequest} />
        )}
      </div>

      {/* Subagents: compact horizontal rows, stacked */}
      {allRecentSubagents.length > 0 && expanded && (
        <div className={styles.subagents}>
          {visibleSubagents.map((subagent) => (
            <SubagentRow
              key={subagent.agentId}
              subagent={subagent}
              color={session.color}
              onClick={() => onSelectSession(session, subagent.agentId)}
            />
          ))}
          {!overflowExpanded && extraCount > 0 && (
            <button className={styles.extraBadge} onClick={(e) => { e.stopPropagation(); setOverflowExpanded(true); }}>+{extraCount} more</button>
          )}
          {overflowExpanded && (
            <button className={styles.extraBadge} onClick={(e) => { e.stopPropagation(); setOverflowExpanded(false); }}>show less</button>
          )}
        </div>
      )}
    </div>
  );
});
