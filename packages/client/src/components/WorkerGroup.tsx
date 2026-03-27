import React from 'react';
import type { Session } from '../types';
import { Worker } from './Worker';
import styles from './WorkerGroup.module.css';

interface WorkerGroupProps {
  session: Session;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customName?: string;
}

const MAX_VISIBLE_SUBAGENTS = 4;

export function WorkerGroup({ session, onSelectSession, customName }: WorkerGroupProps) {
  const activeSubagents = session.subagents.filter(s => s.state !== 'idle');
  const visibleSubagents = activeSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
  const displayName = customName ?? session.proposedName ?? session.slug ?? session.sessionId.slice(0, 8);
  const extraCount = activeSubagents.length - MAX_VISIBLE_SUBAGENTS;

  return (
    <div className={styles.group}>
      {/* Main worker */}
      <div className={styles.mainWorker}>
        <Worker
          sessionId={session.sessionId}
          name={displayName}
          state={session.state}
          color={session.color}
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
          {extraCount > 0 && (
            <div className={styles.extraBadge}>+{extraCount}</div>
          )}
        </div>
      )}
    </div>
  );
}
