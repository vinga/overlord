import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import type { OfficeSnapshot, Session, SessionProvider, SessionReview } from '../types';
import { Room } from './Room';
import { OverlordLogo } from './OverlordLogo';
import { QueueRail } from './QueueRail';
import { ScratchpadPopup } from './ScratchpadPopup';
import { useRoomsListOrder } from '../hooks/useRoomsListOrder';
import { expandRoom } from '../hooks/useRoomCollapsed';
import { useRoomHidden, unhideRoom, seedFromServer } from '../hooks/useRoomHidden';
import { HiddenRoomsPill } from './HiddenRoomsPill';
import { useNotesSummaries } from '../hooks/useNotesSummaries';
import styles from './Office.module.css';

interface OfficeProps {
  snapshot: OfficeSnapshot | null;
  connected: boolean;
  connecting?: boolean;
  onSelectSession: (session: Session, subagentId?: string) => void;
  customNames: Record<string, string>;
  onSpawnSession?: (cwd: string) => void;
  onSpawnDirect?: (cwd: string, name: string, mode: import('../types').TerminalSpawnMode, provider: SessionProvider) => void;
  onNewTerminalSession?: (cwd: string) => void;

  selectedSessionId?: string | null;
  selectionNonce?: number;
  /** False when the last selection came from the inbox rail — open, don't scroll. */
  scrollOnSelect?: boolean;
  /** Rail row click: select without scrolling the grid. */
  onSelectSessionQuiet?: (session: Session) => void;
  rightOffset?: number;
  onRoomClick?: (roomId: string) => void;
  spawnCwd?: string | null;
  onSpawnNameChange?: (name: string) => void;
  onSpawnCommit?: (name: string | null) => void;
  terminalSpawnCwd?: string | null;
  onTerminalSpawnCommit?: (name: string | null) => void;
  onDeleteSession?: (sessionId: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string) => void;
  /** Inbox-rail row actions — same endpoints the DetailPanel StateBadge uses. */
  onSetReview?: (sessionId: string, review: SessionReview | null, reason?: string) => void;
  onToggleRead?: (sessionId: string) => void;
  onOpenArchive?: (entry: import('../types').ArchiveEntry) => void;
  onDeleteArchive?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onCloneSession?: (sessionId: string) => void;
  isPtySession?: (sessionId: string) => boolean;
  pendingSpawns?: Array<{ id: string; cwd: string; fullName: string; startedAt: number }>;
  onOpenDirectoryPicker?: () => void;
  onLogsClick?: () => void;
  onSettingsClick?: () => void;
  onStatsClick?: () => void;
  onOpenAdvancedSearch?: () => void;
  platform?: string;
}

function HeaderMenu({ onNewSession, onLogs, onSettings, onStats, activeOnly, onToggleActiveOnly }: { onNewSession?: () => void; onLogs?: () => void; onSettings?: () => void; onStats?: () => void; activeOnly: boolean; onToggleActiveOnly: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!onNewSession && !onLogs && !onSettings && !onStats) return null;

  return (
    <div ref={ref} className={styles.headerMenu}>
      <button
        className={styles.headerMenuBtn}
        onClick={() => setOpen(o => !o)}
        title="Menu"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor">
          <rect y="0" width="14" height="1.75" rx="0.875" />
          <rect y="5.125" width="14" height="1.75" rx="0.875" />
          <rect y="10.25" width="14" height="1.75" rx="0.875" />
        </svg>
      </button>
      {open && (
        <div className={styles.headerMenuDropdown} role="menu">
          <button
            className={styles.headerMenuItem}
            onClick={() => { setOpen(false); onToggleActiveOnly(); }}
            role="menuitemcheckbox"
            aria-checked={activeOnly}
          >
            <span className={styles.headerMenuItemIcon}>
              {activeOnly ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 8.5 6.5 12 13 4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="3" fill="currentColor" />
                </svg>
              )}
            </span>
            <span className={styles.headerMenuItemLabel}>Active only</span>
            <span className={styles.headerMenuItemHint}>{activeOnly ? 'On' : 'Off'}</span>
          </button>
          {onNewSession && (
            <button
              className={styles.headerMenuItem}
              onClick={() => { setOpen(false); onNewSession(); }}
              role="menuitem"
            >
              <span className={styles.headerMenuItemIcon}>+</span>
              <span className={styles.headerMenuItemLabel}>New session</span>
              <span className={styles.headerMenuItemHint}>Pick a directory</span>
            </button>
          )}
          {onLogs && (
            <button
              className={styles.headerMenuItem}
              onClick={() => { setOpen(false); onLogs(); }}
              role="menuitem"
            >
              <span className={styles.headerMenuItemIcon}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 2.5h7L13 5.5v8a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z" />
                  <path d="M10 2.5V5a.5.5 0 0 0 .5.5H13" />
                  <path d="M5.5 8.5h5M5.5 10.75h5M5.5 6.25h2" />
                </svg>
              </span>
              <span className={styles.headerMenuItemLabel}>Logs</span>
              <span className={styles.headerMenuItemHint}>Server events</span>
            </button>
          )}
          {onSettings && (
            <button
              className={styles.headerMenuItem}
              onClick={() => { setOpen(false); onSettings(); }}
              role="menuitem"
            >
              <span className={styles.headerMenuItemIcon}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="2" />
                  <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
                </svg>
              </span>
              <span className={styles.headerMenuItemLabel}>Settings</span>
              <span className={styles.headerMenuItemHint}>Global options</span>
            </button>
          )}
          {onStats && (
            <button
              className={styles.headerMenuItem}
              onClick={() => { setOpen(false); onStats(); }}
              role="menuitem"
            >
              <span className={styles.headerMenuItemIcon}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="9" width="3" height="5.5" rx="0.5" />
                  <rect x="6.5" y="5.5" width="3" height="9" rx="0.5" />
                  <rect x="11.5" y="1.5" width="3" height="13" rx="0.5" />
                </svg>
              </span>
              <span className={styles.headerMenuItemLabel}>Stats</span>
              <span className={styles.headerMenuItemHint}>Session counts</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatUpdatedAt(updatedAt: string): string {
  try {
    const date = new Date(updatedAt);
    return date.toLocaleTimeString();
  } catch {
    return updatedAt;
  }
}

const ACTIVE_ONLY_STORAGE_KEY = 'overlord:activeOnly';

export const Office = React.memo(function Office({ snapshot, connected, connecting = false, onSelectSession, customNames, onSpawnSession, onSpawnDirect, onNewTerminalSession, selectedSessionId, selectionNonce = 0, scrollOnSelect = true, onSelectSessionQuiet, rightOffset = 0, onRoomClick, spawnCwd, onSpawnNameChange, onSpawnCommit, terminalSpawnCwd, onTerminalSpawnCommit, onDeleteSession, onCloseSession, onArchiveSession, onSetReview, onToggleRead, onOpenArchive, onDeleteArchive, onRenameSession, onCloneSession, isPtySession, pendingSpawns, onOpenDirectoryPicker, onLogsClick, onSettingsClick, onStatsClick, onOpenAdvancedSearch, platform = 'darwin' }: OfficeProps) {
  const rooms = snapshot?.rooms ?? [];
  const { sortRooms, registerRooms, moveRoom } = useRoomsListOrder();
  const notesSummaries = useNotesSummaries();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState<boolean>(() => {
    try { return localStorage.getItem(ACTIVE_ONLY_STORAGE_KEY) === '1'; } catch { return false; }
  });
  // Reported by QueueRail (34px collapsed strip / 288px open). The office pads
  // itself by this so the fixed rail never overlaps the header or the grid.
  const [railWidth, setRailWidth] = useState(34);
  const toggleActiveOnly = useCallback(() => {
    setActiveOnly(prev => {
      const next = !prev;
      try { localStorage.setItem(ACTIVE_ONLY_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const jiraMeta = snapshot?.jiraMeta;
  const sessionMatches = useCallback((s: Session, q: string): boolean => {
    const displayName = customNames[s.sessionId] ?? s.proposedName ?? s.slug ?? '';
    const fields: (string | undefined)[] = [
      displayName,
      s.lastMessage,
      notesSummaries.get(s.sessionId),
      ...(s.subagents ?? []).flatMap(a => [a.agentType, a.description, a.lastActivity]),
      ...(s.jiraKeys ?? []).flatMap(k => {
        const meta = jiraMeta?.[k];
        return [k, meta?.title, meta?.type, meta?.status];
      }),
    ];
    return fields.some(f => typeof f === 'string' && f.toLowerCase().includes(q));
  }, [customNames, notesSummaries, jiraMeta]);

  const { map: hiddenMap, unhide, unhideAll } = useRoomHidden();

  // Merge server-persisted hidden rooms into the local store (once per page
  // load) so hidden state survives fresh browsers and cleared localStorage.
  useEffect(() => {
    seedFromServer(rooms);
  }, [rooms]);

  const visibleRooms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let filtered = rooms.filter(room => room.sessions.length > 0);
    // Hidden rooms leave the grid — except while a search is active, where a
    // match must surface regardless (the room gets a "hidden" badge instead).
    if (!q) {
      filtered = filtered.filter(room => !hiddenMap[room.id]);
    }
    if (activeOnly) {
      filtered = filtered
        .map(room => {
          const sessions = room.sessions.filter(s => s.state !== 'closed');
          return sessions.length > 0 ? { ...room, sessions } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    }
    if (q) {
      filtered = filtered
        .map(room => {
          const roomFields: (string | undefined)[] = [
            room.name,
            room.cwd,
            room.gitBranch,
            room.pullRequest?.title,
            room.pullRequest ? `#${room.pullRequest.number}` : undefined,
          ];
          if (roomFields.some(f => typeof f === 'string' && f.toLowerCase().includes(q))) return room;
          const sessions = room.sessions.filter(s => sessionMatches(s, q));
          return sessions.length > 0 ? { ...room, sessions } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    }
    return sortRooms(filtered);
  }, [rooms, sortRooms, searchQuery, sessionMatches, activeOnly, hiddenMap]);

  // `hiddenRooms` drives the pill list (session-less rooms have nothing to show).
  // `allHiddenRooms` is what "Show all" must operate on: unhideAll only clears the
  // server flag for rooms it is handed, so omitting session-less ones left them
  // hidden on disk and they came back on the next reload.
  const { hiddenRooms, allHiddenRooms, hiddenAttentionCount } = useMemo(() => {
    const all = rooms.filter(r => hiddenMap[r.id]);
    const hr = all.filter(r => r.sessions.length > 0);
    const n = hr.reduce(
      (acc, r) => acc + r.sessions.filter(s => s.state === 'waiting' && s.review == null).length,
      0,
    );
    return { hiddenRooms: hr, allHiddenRooms: all, hiddenAttentionCount: n };
  }, [rooms, hiddenMap]);

  // Register any room IDs not yet in persisted order (side-effect free from render)
  useEffect(() => {
    registerRooms(visibleRooms.map(r => r.id));
  }, [visibleRooms, registerRooms]);

  // Scroll the selected worker's desk into view whenever selection changes
  // (e.g. clicking an agent icon in the DetailPanel, search, or task list).
  // Rooms are read via a ref so snapshot ticks don't re-trigger the scroll.
  // The inbox rail selects quietly (scrollOnSelect=false) — it is its own list,
  // so yanking the grid underneath it would be disorienting.
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const scrollOnSelectRef = useRef(scrollOnSelect);
  scrollOnSelectRef.current = scrollOnSelect;
  useEffect(() => {
    if (!selectedSessionId) return;
    if (!scrollOnSelectRef.current) return;
    const scrollToDesk = () => {
      const sel = CSS.escape(selectedSessionId);
      const desk = document.querySelector(`[data-desk-ovr="${sel}"], [data-desk-sid="${sel}"]`);
      if (desk) { desk.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
      // Desk not rendered — the room is collapsed or hidden. Unhide + expand so
      // the worker is actually reachable, then fall back to the room card for
      // this pass; the 260ms retry below lands on the now-mounted desk.
      const room = roomsRef.current.find(r =>
        r.sessions.some(s => s.overlordId === selectedSessionId || s.sessionId === selectedSessionId)
      );
      if (!room) return;
      unhideRoom(room.id, room.cwd);
      expandRoom(room.id);
      document.querySelector(`[data-room-id="${CSS.escape(room.id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const raf = requestAnimationFrame(scrollToDesk);
    // The detail panel's 200ms width transition reflows the grid — scroll again after it settles
    const timer = setTimeout(scrollToDesk, 260);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [selectedSessionId, selectionNonce]);

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
    <div className={styles.office} style={{ paddingRight: rightOffset, paddingLeft: railWidth, transition: 'padding-right 200ms ease, padding-left 160ms ease' }}>
      <QueueRail
        snapshot={snapshot}
        customNames={customNames}
        onSelectSession={onSelectSessionQuiet ?? onSelectSession}
        onSetReview={onSetReview}
        onToggleRead={onToggleRead}
        selectedSessionId={selectedSessionId}
        onWidthChange={setRailWidth}
      />
      <header className={styles.header}>
        <OverlordLogo />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search agents, JIRA tickets…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); (e.currentTarget as HTMLInputElement).blur(); } }}
        />
        <HiddenRoomsPill
          hiddenRooms={hiddenRooms}
          attentionCount={hiddenAttentionCount}
          onUnhide={unhide}
          onUnhideAll={() => unhideAll(allHiddenRooms)}
        />
        {onOpenAdvancedSearch && (
          <button
            className={styles.advSearchBtn}
            onClick={onOpenAdvancedSearch}
            title="Advanced search across all rooms"
            aria-label="Advanced search"
          >
            <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M4.5 6.5h4M6.5 4.5v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <HeaderMenu
          onNewSession={onOpenDirectoryPicker}
          onLogs={onLogsClick}
          onSettings={onSettingsClick}
          onStats={onStatsClick}
          activeOnly={activeOnly}
          onToggleActiveOnly={toggleActiveOnly}
        />
        <ScratchpadPopup />
      </header>
      <div className={styles.content}>
        {!hasRooms ? (
          <div className={styles.empty}>
            {connecting ? (
              <>
                <span className={styles.emptyText}>Connecting to server</span>
                <span className={styles.cursor} aria-hidden="true">_</span>
              </>
            ) : hiddenRooms.length > 0 && !searchQuery.trim() ? (
              <>
                <span className={styles.emptyText}>All rooms hidden</span>
                <button className={styles.emptyShowAll} onClick={() => unhideAll(allHiddenRooms)}>Show all</button>
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
                  onCloseSession={onCloseSession}
                  onArchiveSession={onArchiveSession}
                  onOpenArchive={onOpenArchive}
                  onDeleteArchive={onDeleteArchive}
                  onRenameSession={onRenameSession}
                  onCloneSession={onCloneSession}
                  isPtySession={isPtySession}
                  pendingSpawns={pendingSpawns?.filter(p => p.cwd === room.cwd)}
                  platform={platform}
                  onRoomDragStart={e => handleDragStart(e, room.id)}
                  onRoomDragEnd={handleDragEnd}
                  searchRevealed={searchQuery.trim().length > 0 && !!hiddenMap[room.id]}
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
