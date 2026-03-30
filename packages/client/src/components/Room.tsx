import React, { useState, useEffect } from 'react';
import type { Room as RoomType, Session } from '../types';
import { WorkerGroup } from './WorkerGroup';
import styles from './Room.module.css';
import { useRoomOrder } from '../hooks/useRoomOrder';

function lastActivityLabel(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '<1m';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h`;
}

interface RoomProps {
  room: RoomType;
  dormitorySessions: Session[];
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  selectedSessionId?: string | null;
  onRoomClick?: (roomId: string) => void;
  isSpawning?: boolean;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

export function Room({ room, dormitorySessions, onSelectSession, customNames, onSpawnSession, selectedSessionId, onRoomClick, isSpawning, onSpawnNameChange, onSpawnCommit, onDeleteSession }: RoomProps) {
  const hasDormitory = dormitorySessions.length > 0;
  const [, setTick] = useState(0);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState('');
  const { getOrder, setOrder } = useRoomOrder();

  // Use room.id as the stable key for localStorage
  const roomKey = room.id;

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isSpawning) setSpawnName('');
  }, [isSpawning]);

  function handleSpawn(e: React.MouseEvent) {
    e.stopPropagation();
    if (onSpawnSession) {
      onSpawnSession(room.cwd);
    }
  }

  const idlePriority = (s: Session) => {
    if (s.state !== 'closed') return 0;
    const mins = (Date.now() - new Date(s.lastActivity).getTime()) / 60000;
    if (mins > 15) return 2;
    if (mins > 5) return 1;
    return 0;
  };

  // Build sorted sessions list respecting custom order
  const continuationIds = new Set(room.sessions.map(s => s.resumedFrom).filter(Boolean) as string[]);
  const standaloneSessions = room.sessions
    .filter(s => !s.resumedFrom || !room.sessions.some(p => p.sessionId === s.resumedFrom));

  const storedOrder = getOrder(roomKey);

  let sortedSessions: Session[];
  if (storedOrder.length > 0) {
    const orderedMap = new Map(storedOrder.map((id, idx) => [id, idx]));
    const inOrder = standaloneSessions
      .filter(s => orderedMap.has(s.sessionId))
      .sort((a, b) => (orderedMap.get(a.sessionId) ?? 0) - (orderedMap.get(b.sessionId) ?? 0));
    const notInOrder = standaloneSessions
      .filter(s => !orderedMap.has(s.sessionId))
      .sort((a, b) => idlePriority(a) - idlePriority(b));
    sortedSessions = [...inOrder, ...notInOrder];
  } else {
    sortedSessions = [...standaloneSessions].sort((a, b) => idlePriority(a) - idlePriority(b));
  }

  const handleDrop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const currentOrder = sortedSessions.map(s => s.sessionId);
    const fromIdx = currentOrder.indexOf(draggedId);
    const toIdx = currentOrder.indexOf(targetId);
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, draggedId);
    setOrder(roomKey, newOrder);
    setDraggedId(null);
    setDragOverId(null);
  };

  return (
    <div className={styles.room}>
      <div className={styles.titleBar}>
        <span
          className={`${styles.roomName} ${onRoomClick ? styles.roomNameClickable : ''}`}
          onClick={onRoomClick ? (e) => { e.stopPropagation(); onRoomClick(room.id); } : undefined}
          role={onRoomClick ? 'button' : undefined}
          tabIndex={onRoomClick ? 0 : undefined}
          onKeyDown={onRoomClick ? (e) => { if (e.key === 'Enter') onRoomClick(room.id); } : undefined}
          title={onRoomClick ? room.cwd : undefined}
        >
          {room.name}
        </span>
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
      {isSpawning && (
        <div className={styles.spawnNameRow}>
          <input
            className={styles.spawnNameInput}
            type="text"
            placeholder="Name this session…"
            value={spawnName}
            autoFocus
            maxLength={60}
            onChange={(e) => {
              setSpawnName(e.target.value);
              onSpawnNameChange?.(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onSpawnCommit?.(spawnName);
              } else if (e.key === 'Escape') {
                onSpawnCommit?.('');
              }
            }}
            onBlur={() => onSpawnCommit?.(spawnName)}
          />
          <span className={styles.spawnNameHint}>Starting…</span>
        </div>
      )}
      <div className={styles.desks}>
        {sortedSessions.map((session) => {
          const isSelected = session.sessionId === selectedSessionId;
          const isDragging = draggedId === session.sessionId;
          const isDragOver = dragOverId === session.sessionId && draggedId !== session.sessionId;
          return (
            <div
              key={session.sessionId}
              className={[
                styles.desk,
                isSelected ? styles.deskSelected : '',
                isDragging ? styles.dragging : '',
                isDragOver ? styles.dragOver : '',
              ].filter(Boolean).join(' ')}
              draggable={true}
              onDragStart={() => setDraggedId(session.sessionId)}
              onDragOver={(e) => { e.preventDefault(); setDragOverId(session.sessionId); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(session.sessionId); }}
              onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
            >
              <span className={styles.dragHandle} aria-hidden="true">⠿</span>
              <div className={styles.deskTimeLabel}>{lastActivityLabel(session.lastActivity)}</div>
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} onDeleteSession={onDeleteSession} />
              {continuationIds.has(session.sessionId) && (
                <div className={styles.continuationBadge} title="Session has a continuation">→</div>
              )}
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
                  onDeleteSession={onDeleteSession}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
