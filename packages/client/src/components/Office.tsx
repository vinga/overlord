import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import type { OfficeSnapshot, Session } from '../types';
import { Room } from './Room';
import { OverlordLogo } from './OverlordLogo';
import { useRoomsListOrder } from '../hooks/useRoomsListOrder';
import styles from './Office.module.css';

interface OfficeProps {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  connecting?: boolean;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  onSpawnDirect?: (cwd: string, name: string, mode: import('../types').TerminalSpawnMode) => void;
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
  onOpenDirectoryPicker?: () => void;
  onLogsClick?: () => void;
  platform?: string;
}

function formatUpdatedAt(updatedAt: string): string {
  try {
    const date = new Date(updatedAt);
    return date.toLocaleTimeString();
  } catch {
    return updatedAt;
  }
}

export const Office = React.memo(function Office({ snapshot, connected, connecting = false, onSelectSession, customNames, onSpawnSession, onSpawnDirect, onNewTerminalSession, selectedSessionId, rightOffset = 0, onRoomClick, spawnCwd, onSpawnNameChange, onSpawnCommit, terminalSpawnCwd, onTerminalSpawnCommit, onDeleteSession, onRenameSession, onCloneSession, isPtySession, onOpenDirectoryPicker, onLogsClick, platform = 'darwin' }: OfficeProps) {
  const rooms = snapshot?.rooms ?? [];
  const { sortRooms, registerRooms, moveRoom } = useRoomsListOrder();

  const visibleRooms = useMemo(() => {
    const filtered = rooms.filter(room => room.sessions.length > 0);
    return sortRooms(filtered);
  }, [rooms, sortRooms]);

  // Register any room IDs not yet in persisted order (side-effect free from render)
  useEffect(() => {
    registerRooms(visibleRooms.map(r => r.id));
  }, [visibleRooms, registerRooms]);

  const hasRooms = visibleRooms.length > 0;

  // Drag-and-drop state
  const draggedId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, roomId: string) => {
    draggedId.current = roomId;
    e.dataTransfer.effectAllowed = 'move';
    // Use the room wrapper as the drag image so the user sees the full card
    const wrapper = (e.currentTarget as HTMLElement).closest('[data-room-id]') as HTMLElement | null;
    if (wrapper) e.dataTransfer.setDragImage(wrapper, 20, 20);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, roomId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedId.current && roomId !== draggedId.current) {
      setDragOverId(roomId);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (draggedId.current && draggedId.current !== targetId) {
      moveRoom(draggedId.current, targetId);
    }
    draggedId.current = null;
    setDragOverId(null);
  }, [moveRoom]);

  const handleDragEnd = useCallback(() => {
    draggedId.current = null;
    setDragOverId(null);
  }, []);

  return (
    <div className={styles.office} style={{ paddingRight: rightOffset, transition: 'padding-right 200ms ease' }}>
      <header className={styles.header}>
        <OverlordLogo />
        {onOpenDirectoryPicker && (
          <button className={styles.newSessionBtn} onClick={onOpenDirectoryPicker}>
            + New Session
          </button>
        )}
        {onLogsClick && (
          <button className={styles.logsBtn} onClick={onLogsClick}>
            Logs
          </button>
        )}
      </header>
      <div className={styles.content}>
        {!hasRooms ? (
          <div className={styles.empty}>
            {connecting ? (
              <>
                <span className={styles.emptyText}>Connecting to server</span>
                <span className={styles.cursor} aria-hidden="true">_</span>
              </>
            ) : (
              <>
                <span className={styles.emptyText}>No active sessions</span>
                <span className={styles.cursor} aria-hidden="true">_</span>
              </>
            )}
          </div>
        ) : (
          <div className={styles.grid}>
            {visibleRooms.map((room) => (
              <div
                key={room.id}
                data-room-id={room.id}
                className={`${styles.roomWrapper} ${dragOverId === room.id ? styles.dragOver : ''}`}
                onDragOver={e => handleDragOver(e, room.id)}
                onDrop={e => handleDrop(e, room.id)}
              >
                <Room
                  room={room}
                  onSelectSession={onSelectSession}
                  customNames={customNames}
                  onSpawnSession={onSpawnSession}
                  onSpawnDirect={onSpawnDirect}
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
                  platform={platform}
                  onRoomDragStart={e => handleDragStart(e, room.id)}
                  onRoomDragEnd={handleDragEnd}
                />
              </div>
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
