import React, { useState, useEffect } from 'react';
import type { Room as RoomType, Session } from '../types';
import { getLaunchInfo } from '../types';
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

  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  selectedSessionId?: string | null;
  onRoomClick?: (roomId: string) => void;
  isSpawning?: boolean;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCloneSession?: (sessionId: string) => void;
  onNewTerminalSession?: (cwd: string) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string) => void;
  isPtySession?: (sessionId: string) => boolean;
}

function DeskMenu({ onDelete, onRename, onClone, currentName }: { onDelete: () => void; onRename?: (name: string) => void; onClone?: () => void; currentName?: string }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setRenaming(false); }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'absolute', top: 4, right: 4, zIndex: 10 }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); setRenaming(false); }}
        style={{
          background: 'rgba(30,30,40,0.85)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4, color: 'rgba(255,255,255,0.4)', width: 22, height: 22,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, opacity: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
        title="Options"
      >
        <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor">
          <rect y="0" width="12" height="1.5" rx="0.75"/>
          <rect y="4.25" width="12" height="1.5" rx="0.75"/>
          <rect y="8.5" width="12" height="1.5" rx="0.75"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 26, right: 0, background: '#1e1e2e',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 100, minWidth: 140,
        }}>
          {renaming ? (
            <div style={{ padding: '4px 8px' }}>
              <input
                autoFocus
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameVal.trim()) { onRename?.(nameVal.trim()); setOpen(false); setRenaming(false); }
                  if (e.key === 'Escape') { setRenaming(false); }
                }}
                style={{
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4, color: '#fff', padding: '4px 8px', fontSize: 12, width: '100%',
                  outline: 'none', fontFamily: 'Inter, system-ui, sans-serif',
                }}
                placeholder="New name…"
              />
            </div>
          ) : (
            <>
              {onRename && (
                <button
                  onClick={() => { setNameVal(currentName ?? ''); setRenaming(true); }}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px',
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                    fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
                >Rename</button>
              )}
              {onClone && (
                <button
                  onClick={(e) => { e.stopPropagation(); setOpen(false); onClone(); }}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px',
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                    fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
                >Clone</button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
                style={{
                  display: 'block', width: '100%', padding: '8px 14px',
                  background: 'none', border: 'none', color: '#ff6b6b',
                  fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,107,107,0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SpawnMenu({ cwd, onSpawnEmbedded, onSpawnTerminal }: { cwd: string; onSpawnEmbedded: () => void; onSpawnTerminal?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    display: 'block', width: '100%', padding: '8px 14px',
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
    fontSize: 13, textAlign: 'left', cursor: 'pointer', borderRadius: 6,
    whiteSpace: 'nowrap',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={styles.spawnButton}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title={`New Claude session in ${cwd}`}
        aria-label="New session menu"
      >
        +
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8, padding: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          zIndex: 100, minWidth: 180,
        }}>
          <button
            style={itemStyle}
            onClick={() => { setOpen(false); onSpawnEmbedded(); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >New Overlord Session</button>
          {onSpawnTerminal && (
            <button
              style={itemStyle}
              onClick={() => { setOpen(false); onSpawnTerminal(); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >New Terminal Session</button>
          )}
        </div>
      )}
    </div>
  );
}

export function Room({ room, onSelectSession, customNames, onSpawnSession, selectedSessionId, onRoomClick, isSpawning, onSpawnNameChange, onSpawnCommit, onDeleteSession, onRenameSession, onCloneSession, onNewTerminalSession, terminalSpawnCwd, onTerminalSpawnCommit, isPtySession }: RoomProps) {
  const [, setTick] = useState(0);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState('');
  const [terminalSpawnName, setTerminalSpawnName] = useState('');
  const { getOrder, setOrder } = useRoomOrder();

  const isTerminalSpawning = terminalSpawnCwd === room.cwd;

  // Compute next "Session-X" name
  function getNextSessionName(): string {
    const existing = Object.values(customNames);
    let max = 0;
    for (const name of existing) {
      const match = name.match(/^Session-(\d+)$/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `Session-${max + 1}`;
  }

  // Use room.id as the stable key for localStorage
  const roomKey = room.id;

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isSpawning) setSpawnName('');
  }, [isSpawning]);

  useEffect(() => {
    if (isTerminalSpawning) {
      setTerminalSpawnName(getNextSessionName());
    } else {
      setTerminalSpawnName('');
    }
  }, [isTerminalSpawning]);

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
  const allSessions = room.sessions;

  const storedOrder = getOrder(roomKey);

  let sortedSessions: Session[];
  if (storedOrder.length > 0) {
    const orderedMap = new Map(storedOrder.map((id, idx) => [id, idx]));
    const inOrder = allSessions
      .filter(s => orderedMap.has(s.sessionId))
      .sort((a, b) => (orderedMap.get(a.sessionId) ?? 0) - (orderedMap.get(b.sessionId) ?? 0));
    const notInOrder = allSessions
      .filter(s => !orderedMap.has(s.sessionId))
      .sort((a, b) => idlePriority(a) - idlePriority(b));
    sortedSessions = [...inOrder, ...notInOrder];
  } else {
    sortedSessions = [...allSessions].sort((a, b) => idlePriority(a) - idlePriority(b));
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
          <SpawnMenu
            cwd={room.cwd}
            onSpawnEmbedded={() => onSpawnSession?.(room.cwd)}
            onSpawnTerminal={onNewTerminalSession ? () => onNewTerminalSession(room.cwd) : undefined}
          />
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
      {isTerminalSpawning && (
        <div className={styles.spawnNameRow}>
          <input
            className={styles.spawnNameInput}
            type="text"
            placeholder="Name this session…"
            value={terminalSpawnName}
            autoFocus
            maxLength={60}
            onChange={(e) => setTerminalSpawnName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onTerminalSpawnCommit?.(terminalSpawnName);
              } else if (e.key === 'Escape') {
                onTerminalSpawnCommit?.('');
              }
            }}
            onBlur={() => onTerminalSpawnCommit?.(terminalSpawnName)}
          />
          <span className={styles.spawnNameHint}>Terminal</span>
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
              <div className={styles.deskInfo}>
                <div className={styles.deskTimeLabel}>{lastActivityLabel(session.lastActivity)}</div>
                {(() => {
                  const launch = getLaunchInfo(session, isPtySession?.(session.sessionId));
                  return (
                    <div className={styles.deskLaunchRow}>
                      <span className={styles.deskLaunchBadge} data-method={launch.category}>{launch.name}</span>
                    </div>
                  );
                })()}
              </div>
              {onDeleteSession && (
                <DeskMenu
                  onDelete={() => onDeleteSession(session.sessionId)}
                  onRename={onRenameSession ? (name) => onRenameSession(session.sessionId, name) : undefined}
                  onClone={onCloneSession && session.activityFeed && session.activityFeed.length > 0 ? () => onCloneSession(session.sessionId) : undefined}
                  currentName={customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8)}
                />
              )}
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} onDeleteSession={onDeleteSession} onRename={onRenameSession} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
