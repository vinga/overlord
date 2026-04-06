import React, { useMemo } from 'react';
import type { OfficeSnapshot, Session } from '../types';
import { Room } from './Room';
import { OverlordLogo } from './OverlordLogo';
import styles from './Office.module.css';

interface OfficeProps {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  onNewTerminalSession?: (cwd: string) => void;

  selectedSessionId?: string | null;
  rightOffset?: number;
  onRoomClick?: (roomId: string) => void;
  spawnCwd?: string | null;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string | null) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string | null) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onCloneSession?: (sessionId: string) => void;
  isPtySession?: (sessionId: string) => boolean;
}

function formatUpdatedAt(updatedAt: string): string {
  try {
    const date = new Date(updatedAt);
    return date.toLocaleTimeString();
  } catch {
    return updatedAt;
  }
}

export const Office = React.memo(function Office({ snapshot, connected, onSelectSession, customNames, onSpawnSession, onNewTerminalSession, selectedSessionId, rightOffset = 0, onRoomClick, spawnCwd, onSpawnNameChange, onSpawnCommit, terminalSpawnCwd, onTerminalSpawnCommit, onDeleteSession, onRenameSession, onCloneSession, isPtySession }: OfficeProps) {
  const rooms = snapshot?.rooms ?? [];

  const visibleRooms = useMemo(() =>
    rooms.filter(room => room.sessions.length > 0),
    [rooms]
  );

  const hasRooms = visibleRooms.length > 0;

  return (
    <div className={styles.office} style={{ paddingRight: rightOffset, transition: 'padding-right 200ms ease' }}>
      <header className={styles.header}>
        <OverlordLogo />
      </header>
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
                room={room}
                onSelectSession={onSelectSession}
                customNames={customNames}
                onSpawnSession={onSpawnSession}
                onNewTerminalSession={onNewTerminalSession}
                selectedSessionId={selectedSessionId}
                onRoomClick={onRoomClick}
                isSpawning={spawnCwd === room.cwd}
                onSpawnNameChange={onSpawnNameChange}
                onSpawnCommit={onSpawnCommit}
                terminalSpawnCwd={terminalSpawnCwd}
                onTerminalSpawnCommit={onTerminalSpawnCommit}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onCloneSession={onCloneSession}
                isPtySession={isPtySession}
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
});
