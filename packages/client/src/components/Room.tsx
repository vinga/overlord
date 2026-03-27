import React from 'react';
import type { Room as RoomType, Session } from '../types';
import { WorkerGroup } from './WorkerGroup';
import styles from './Room.module.css';

interface RoomProps {
  room: RoomType;
  dormitorySessions: Session[];
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  selectedSessionId?: string | null;
}

export function Room({ room, dormitorySessions, onSelectSession, customNames, onSpawnSession, selectedSessionId }: RoomProps) {
  const hasDormitory = dormitorySessions.length > 0;

  function handleSpawn(e: React.MouseEvent) {
    e.stopPropagation();
    if (onSpawnSession) {
      onSpawnSession(room.cwd);
    }
  }

  return (
    <div className={styles.room}>
      <div className={styles.titleBar}>
        <span className={styles.roomName}>{room.name}</span>
        {onSpawnSession && (
          <button
            className={styles.spawnButton}
            onClick={handleSpawn}
            title={`New Claude session in ${room.cwd}`}
            aria-label="Spawn new Claude session in this workspace"
          >
            +
          </button>
        )}
      </div>
      <div className={styles.desks}>
        {room.sessions.map((session) => {
          const isSelected = session.sessionId === selectedSessionId;
          return (
            <div
              key={session.sessionId}
              className={`${styles.desk} ${isSelected ? styles.deskSelected : ''}`}
              style={undefined}
            >
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} />
            </div>
          );
        })}
      </div>
      {hasDormitory && (
        <div className={styles.dormitory}>
          <div className={styles.dormitoryLabel}>dormitory</div>
          <div className={styles.dormitoryDesks}>
            {dormitorySessions.map((session) => (
              <div key={session.sessionId} className={styles.dormitoryDesk}>
                <WorkerGroup
                  session={session}
                  onSelectSession={onSelectSession}
                  customName={customNames[session.sessionId]}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
