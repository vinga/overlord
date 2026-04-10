import React, { useState, useEffect, useRef } from 'react';
import type { Room as RoomType, Session, TerminalSpawnMode } from '../types';
import { getLaunchInfo } from '../types';
import { WorkerGroup } from './WorkerGroup';
import styles from './Room.module.css';
import { useRoomOrder } from '../hooks/useRoomOrder';
import { useRoomCollapsed } from '../hooks/useRoomCollapsed';

// 300 distinctive names for new sessions — pick a random unused one
export const SESSION_NAMES = [
  'Alaric','Amara','Ashton','Astrid','Aurelia','Balthazar','Bastian','Beatrix','Bramble','Brynhild',
  'Callisto','Caspian','Cassius','Cedar','Celestine','Dagny','Dashiell','Delphine','Dusk','Dmitri',
  'Eirik','Elowen','Ember','Enrique','Esme','Falcon','Florian','Freya','Fujin','Felix',
  'Gautier','Gideon','Grove','Gunnar','Galatea','Hadrian','Halcyon','Hazel','Hikaru','Hector',
  'Idris','Ingrid','Isolde','Indigo','Isadora','Jasper','Jinhai','Jorvik','Juniper','Juno',
  'Kael','Kaida','Kestrel','Kieran','Knox','Lark','Leander','Lirien','Lysander','Lucian',
  'Magnus','Marcellus','Mireille','Moss','Maeve','Nero','Niamh','Nyx','Noelle','Naveen',
  'Octavia','Odin','Onyx','Orion','Ophelia','Paloma','Percival','Petra','Petal','Phoenix',
  'Quillan','Quillon','Quentin','Quinlan','Quade','Rafaela','Ragnar','Raven','Rosalind','Rune',
  'Sable','Sigrid','Soren','Storm','Stellan','Talon','Thalassa','Theron','Torsten','Thistle',
  'Ulric','Ulfric','Umber','Ursa','Ulysse','Vale','Vesper','Viggo','Vidar','Valentina',
  'Wahid','Wilder','Wren','Wynne','Wolfgang','Xanthe','Xiomara','Xander','Xerxes','Xyla',
  'Yael','Ysolde','Yuki','Yarrow','Yves','Zephyr','Zora','Zenith','Zahir','Zinnia',
  'Rowan','Thane','Elara','Cassian','Saffron','Oberon','Linnea','Cosimo','Fenrir','Solana',
  'Altair','Briar','Calyx','Dante','Eclipse','Finch','Garnet','Haven','Iona','Jovian',
  'Katya','Lazarus','Meridian','Noor','Oleander','Pax','Rhiannon','Solstice','Tiberius','Umbra',
  'Vega','Willow','Xylo','Yara','Zander','Anika','Blaise','Corvus','Daria','Elodie',
  'Fable','Galen','Harlow','Inara','Jericho','Koda','Linden','Maren','Nemo','Orla',
  'Sage','Tavi','Vexen','Whisper','Xeno','Arwen','Blythe','Cyrus','Dione','Eris',
  'Fern','Greer','Helios','Arden','Kira','Lumen','Milo','Nico','Opal','Pike',
  'Rook','Slate','Tarn','Voss','Wynn','Ximena','Zarya','Ajax','Birch','Cleo',
  'Draco','Etta','Flint','Gale','Heron','Iris','Jace','Kelda','Lyric','Mace',
  'Nash','Priya','Shale','Teal','Vane','Corvo','Dove','Echo','Frost','Grail',
  'Heath','Ibis','Jade','Nell','Oaken','Penn','Rhea','Skye','Axel','Beck',
  'Crux','Fenn','Halo','Jett','Nord','Pyre','Astra','Blaze','Cade','Drift',
  'Flux','Grit','Seren','Larkin','Mercer','Sparrow','Hollis','Bronte','Isidore','Clover',
  'Evander','Fielding','Gareth','Hadley','Ianthe','Jasmine','Kellan','Lorelei','Maddox','Nolan',
  'Olexa','Pascal','Reverie','Simone','Tamsin','Ulyana','Viktor','Waverly','Xaldin','Yasmin',
  'Zephyra','Archer','Bellamy','Cedric','Dulcie','Esmera','Fabian','Gemma','Harper','Ignace',
  'Jorah','Atlas','Isolde','Cinder','Thalia','Oriel','Ronan','Sable','Lyra','Ember',
];

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
  onSpawnCommit?: (name: string | null) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCloneSession?: (sessionId: string) => void;
  onNewTerminalSession?: (cwd: string, mode?: TerminalSpawnMode) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string | null) => void;
  isPtySession?: (sessionId: string) => boolean;
  onRoomDragStart?: (e: React.DragEvent) => void;
  onRoomDragEnd?: () => void;
}

function DeskMenu({ onDelete, onRename, onClone, onClear, currentName }: { onDelete: () => void; onRename?: (name: string) => void; onClone?: () => void; onClear?: () => void; currentName?: string }) {
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
              {onClear && (
                <button
                  onClick={(e) => { e.stopPropagation(); setOpen(false); onClear(); }}
                  style={{
                    display: 'block', width: '100%', padding: '8px 14px',
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                    fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(251,146,60,0.1)'; e.currentTarget.style.color = '#fb923c'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
                >Clear</button>
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

function SpawnMenu({ cwd, onSpawnEmbedded, onSpawnTerminal }: { cwd: string; onSpawnEmbedded: () => void; onSpawnTerminal?: (mode?: TerminalSpawnMode) => void }) {
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
          {onSpawnTerminal && (<>
            <button
              style={itemStyle}
              onClick={() => { setOpen(false); onSpawnTerminal('bridge'); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >New Terminal (bridge)</button>
            <button
              style={itemStyle}
              onClick={() => { setOpen(false); onSpawnTerminal('plain'); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >New Terminal (direct)</button>
          </>)}
        </div>
      )}
    </div>
  );
}

export function Room({ room, onSelectSession, customNames, onSpawnSession, selectedSessionId, onRoomClick, isSpawning, onSpawnNameChange, onSpawnCommit, onDeleteSession, onRenameSession, onCloneSession, onNewTerminalSession, terminalSpawnCwd, onTerminalSpawnCommit, isPtySession, onRoomDragStart, onRoomDragEnd }: RoomProps) {
  const [, setTick] = useState(0);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState('');
  const [terminalSpawnName, setTerminalSpawnName] = useState('');
  const [terminalMode, setTerminalMode] = useState<TerminalSpawnMode>('bridge');
  const { getOrder, setOrder } = useRoomOrder();
  const { isCollapsed, toggle } = useRoomCollapsed();
  const collapsed = isCollapsed(room.id);

  const isTerminalSpawning = terminalSpawnCwd === room.cwd;

  function getNextName(prefix: string, separator: string = '+'): string {
    const usedNames = new Set([
      ...Object.values(customNames),
      ...room.sessions.map(s => s.proposedName).filter(Boolean),
    ] as string[]);
    // Pick a random unused name from the pool
    const available = SESSION_NAMES.filter(n => !usedNames.has(n));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)];
    }
    // Fallback: numbered names if all 300 are taken
    let max = 0;
    const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${prefix}\\${escapedSep}(\\d+)$`);
    for (const name of usedNames) {
      const match = name?.match(pattern);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `${prefix}${separator}${max + 1}`;
  }

  // Use room.id as the stable key for localStorage
  const roomKey = room.id;

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const spawnInputRef = useRef<HTMLInputElement>(null);
  const terminalSpawnInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isSpawning) {
      const name = getNextName('OVERLORD');
      setSpawnName(name);
      onSpawnNameChange?.(name);
      setTimeout(() => { spawnInputRef.current?.focus(); spawnInputRef.current?.select(); }, 50);
    } else {
      setSpawnName('');
    }
  }, [isSpawning]);

  useEffect(() => {
    if (isTerminalSpawning) {
      const prefix = terminalMode === 'bridge' ? 'BRIDGE' : 'DIRECT';
      const sep = terminalMode === 'bridge' ? '+' : '*';
      const name = getNextName(prefix, sep);
      setTerminalSpawnName(name);
      setTimeout(() => { terminalSpawnInputRef.current?.focus(); terminalSpawnInputRef.current?.select(); }, 50);
    } else {
      setTerminalSpawnName('');
    }
  }, [isTerminalSpawning, terminalMode]);

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

  // Compute state counts for collapsed summary
  const stateCounts = room.sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className={`${styles.room} ${collapsed ? styles.roomCollapsed : ''}`}>
      <div className={styles.titleBar}>
        {onRoomDragStart && (
          <div
            className={styles.dragHandle}
            draggable
            onDragStart={onRoomDragStart}
            onDragEnd={onRoomDragEnd}
            title="Drag to reorder room"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
              <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
              <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
            </svg>
          </div>
        )}
        <button
          className={styles.collapseBtn}
          onClick={() => toggle(room.id)}
          data-tooltip={collapsed ? 'Expand room' : 'Collapse room'}
          data-tooltip-dir="down"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
            <polyline points="2 3 5 6 8 3" />
          </svg>
        </button>
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
        {collapsed && (
          <div className={styles.collapsedChips}>
            {(['working', 'thinking', 'waiting', 'closed'] as const).map(state => {
              const count = stateCounts[state];
              if (!count) return null;
              return (
                <span key={state} className={`${styles.stateChip} ${styles[`stateChip_${state}`]}`} data-tooltip={`${count} ${state}`}>
                  {count}
                </span>
              );
            })}
          </div>
        )}
        {onSpawnSession && (
          <div style={{ position: 'relative' }}>
            <SpawnMenu
              cwd={room.cwd}
              onSpawnEmbedded={() => onSpawnSession?.(room.cwd)}
              onSpawnTerminal={onNewTerminalSession ? (mode?: TerminalSpawnMode) => { setTerminalMode(mode || 'bridge'); onNewTerminalSession(room.cwd, mode); } : undefined}
            />
            {(isSpawning || isTerminalSpawning) && (
              <div className={styles.spawnPopup}>
            <input
              ref={isSpawning ? spawnInputRef : terminalSpawnInputRef}
              className={styles.spawnNameInput}
              type="text"
              placeholder="Session name…"
              value={isSpawning ? spawnName : terminalSpawnName}
              maxLength={60}
              onChange={(e) => {
                if (isSpawning) {
                  setSpawnName(e.target.value);
                  onSpawnNameChange?.(e.target.value);
                } else {
                  setTerminalSpawnName(e.target.value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (isSpawning) onSpawnCommit?.(spawnName);
                  else onTerminalSpawnCommit?.(terminalSpawnName);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  if (isSpawning) onSpawnCommit?.(null);
                  else onTerminalSpawnCommit?.(null);
                }
              }}
              onBlur={() => {
                if (isSpawning) onSpawnCommit?.(null);
                else onTerminalSpawnCommit?.(null);
              }}
            />
          </div>
        )}
          </div>
        )}
      </div>
      {!collapsed && <div className={styles.desks}>
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
                      <span className={styles.deskLaunchBadge} data-category={launch.category}>{launch.name}</span>
                    </div>
                  );
                })()}
              </div>
              {onDeleteSession && (
                <DeskMenu
                  onDelete={() => onDeleteSession(session.sessionId)}
                  onRename={onRenameSession ? (name) => onRenameSession(session.sessionId, name) : undefined}
                  onClone={onCloneSession && session.activityFeed && session.activityFeed.length > 0 ? () => onCloneSession(session.sessionId) : undefined}
                  onClear={session.state !== 'closed' ? () => {
                    fetch(`/api/sessions/${session.sessionId}/inject`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: '/clear\r' }),
                    }).catch(() => null);
                  } : undefined}
                  currentName={customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8)}
                />
              )}
              <WorkerGroup session={session} onSelectSession={onSelectSession} customName={customNames[session.sessionId]} onDeleteSession={onDeleteSession} onRename={onRenameSession} />
            </div>
          );
        })}
      </div>}
    </div>
  );
}
