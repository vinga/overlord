import React from 'react';
import type { OfficeSnapshot, Session } from '../types';
import { Room } from './Room';
import styles from './Office.module.css';

interface OfficeProps {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  dormitorySessions: Set<string>;
  selectedSessionId?: string | null;
  rightOffset?: number;
}

function formatUpdatedAt(updatedAt: string): string {
  try {
    const date = new Date(updatedAt);
    return date.toLocaleTimeString();
  } catch {
    return updatedAt;
  }
}

export function Office({ snapshot, connected, onSelectSession, customNames, onSpawnSession, dormitorySessions, selectedSessionId, rightOffset = 0 }: OfficeProps) {
  const rooms = snapshot?.rooms ?? [];

  const visibleRooms = rooms
    .map(room => ({
      ...room,
      activeSessions: room.sessions.filter(s => !dormitorySessions.has(s.sessionId)),
      dormitorySessions: room.sessions.filter(s => dormitorySessions.has(s.sessionId)),
    }))
    .filter(room => room.sessions.length > 0);

  const hasRooms = visibleRooms.length > 0;

  return (
    <div className={styles.office} style={{ paddingRight: rightOffset, transition: 'padding-right 200ms ease' }}>
      <div className={styles.content}>
        {!hasRooms ? (
          <div className={styles.empty}>
            <span className={styles.emptyText}>No active sessions</span>
            <span className={styles.cursor} aria-hidden="true">_</span>
          </div>
        ) : (
          <div className={styles.grid}>
            {visibleRooms.map((room) => (
              <Room
                key={room.id}
                room={{ ...room, sessions: room.activeSessions }}
                dormitorySessions={room.dormitorySessions}
                onSelectSession={onSelectSession}
                customNames={customNames}
                onSpawnSession={onSpawnSession}
                selectedSessionId={selectedSessionId}
              />
            ))}
          </div>
        )}
      </div>

      <div className={styles.statusBar}>
        <span className={`${styles.statusIndicator} ${connected ? styles.connected : styles.reconnecting}`} />
        <span className={styles.statusText}>
          {connected ? 'Connected' : 'Reconnecting...'}
        </span>
        {snapshot?.updatedAt && (
          <span className={styles.timestamp}>
            &nbsp;&bull;&nbsp;{formatUpdatedAt(snapshot.updatedAt)}
          </span>
        )}
      </div>
    </div>
  );
}
