import React, { useState, memo } from 'react';
import type { Session } from '../types';
import { Worker } from './Worker';
import styles from './WorkerGroup.module.css';

interface WorkerGroupProps {
  session: Session;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customName?: string;
  onDeleteSession?: (sessionId: string) => void;
}

const MAX_VISIBLE_SUBAGENTS = 4;

export const WorkerGroup = memo(function WorkerGroup({ session, onSelectSession, customName, onDeleteSession }: WorkerGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const allRecentSubagents = session.userAccepted ? [] : session.subagents.filter(s =>
    s.state === 'working' || s.state === 'thinking' ||
    ((s.state === 'waiting' || s.state === 'closed') && Date.now() - new Date(s.lastActivity).getTime() < 4 * 60 * 1000)
  );
  const visibleSubagents = expanded ? allRecentSubagents : allRecentSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
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
          completionHint={session.completionHint}
          completionSummaries={session.completionSummaries}
          userAccepted={session.userAccepted}
          needsPermission={session.needsPermission}
          currentTaskLabel={session.currentTaskLabel}
          isWorker={session.isWorker}
          onClick={() => onSelectSession(session)}
        />
      </div>

      {/* Subagents arc */}
      {visibleSubagents.length > 0 && (
        <div className={styles.subagents}>
          {visibleSubagents.map((subagent, index) => (
            <div
              key={subagent.agentId}
              className={styles.subagentWrapper}
              style={{ '--subagent-index': index, '--subagent-total': visibleSubagents.length } as React.CSSProperties}
            >
              <Worker
                sessionId={subagent.agentId}
                state={subagent.state}
                color={session.color}
                isSubagent
                agentType={subagent.description || subagent.agentType}
                onClick={() => onSelectSession(session, subagent.agentId)}
              />
            </div>
          ))}
          {!expanded && extraCount > 0 && (
            <button className={styles.extraBadge} onClick={() => setExpanded(true)}>+{extraCount}</button>
          )}
          {expanded && (
            <button className={styles.extraBadge} onClick={() => setExpanded(false)}>−</button>
          )}
        </div>
      )}
    </div>
  );
});
