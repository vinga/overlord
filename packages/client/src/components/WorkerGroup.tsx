import React, { useState, useCallback, memo } from 'react';
import type { Session } from '../types';
import { Worker } from './Worker';
import styles from './WorkerGroup.module.css';

interface WorkerGroupProps {
  session: Session;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customName?: string;
  onDeleteSession?: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
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

function writeExpanded(sessionId: string, value: boolean): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map = raw ? JSON.parse(raw) as Record<string, boolean> : {};
    map[sessionId] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export const WorkerGroup = memo(function WorkerGroup({ session, onSelectSession, customName, onDeleteSession, onRename }: WorkerGroupProps) {
  const [expanded, setExpanded] = useState(() => readExpanded(session.sessionId));
  const [overflowExpanded, setOverflowExpanded] = useState(false);

  const allRecentSubagents = session.userAccepted ? [] : session.subagents.filter(s =>
    s.state === 'working' || s.state === 'thinking' ||
    ((s.state === 'waiting' || s.state === 'closed') && Date.now() - new Date(s.lastActivity).getTime() < 4 * 60 * 1000)
  );

  const visibleSubagents = overflowExpanded ? allRecentSubagents : allRecentSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
  const displayName = customName ?? session.proposedName ?? session.slug ?? session.sessionId.slice(0, 8);
  const extraCount = allRecentSubagents.length - MAX_VISIBLE_SUBAGENTS;

  const toggleExpanded = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => {
      const next = !prev;
      writeExpanded(session.sessionId, next);
      return next;
    });
  }, [session.sessionId]);

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
          currentTask={session.currentTask}
          isWorker={session.isWorker}
          ptyInputPendingSince={session.ptyInputPendingSince}
          onClick={() => onSelectSession(session)}
          onRename={onRename ? (name) => onRename(session.sessionId, name) : undefined}
        />
      </div>

      {/* Subagents arc */}
      {allRecentSubagents.length > 0 && (
        <>
          {expanded && (
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
              {!overflowExpanded && extraCount > 0 && (
                <button className={styles.extraBadge} onClick={(e) => { e.stopPropagation(); setOverflowExpanded(true); }}>+{extraCount}</button>
              )}
              {overflowExpanded && (
                <button className={styles.extraBadge} onClick={(e) => { e.stopPropagation(); setOverflowExpanded(false); }}>−</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});
