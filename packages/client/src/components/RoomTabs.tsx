import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Room, Session } from '../types';
import { expandRoom } from '../hooks/useRoomCollapsed';
import { useRoomOrder } from '../hooks/useRoomOrder';
import { sortRoomSessions } from '../lib/roomSessionOrder';
import { hasBackground, isAgent, isBusy, turnEnded } from '../lib/sessionAttention';
import { SOURCE_LABEL, type SearchSource } from '../lib/searchSources';
import { GROUPS_COLLAPSED_EVENT, groupKey, putGroup, readCollapsedGroups, renameGroup, writeCollapsedGroups } from '../lib/sessionGroups';
import styles from './RoomTabs.module.css';

interface RoomTabsProps {
  rooms: Room[];
  archiveCounts?: Record<string, number>;
  sessionCounts?: Record<string, number>;
  onHide?: (roomId: string, cwd: string) => void;
  /** The scrolling grid container — tabs scroll it and track which room is on top. */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Drag-to-reorder: moves `draggedId` in front of `targetId` (shared room order). */
  onMove: (draggedId: string, targetId: string) => void;
  /** Settings toggle: list each room's open sessions as clickable dots. */
  showSessions?: boolean;
  customNames?: Record<string, string>;
  selectedSessionId?: string | null;
  onSelectSession?: (session: Session) => void;
  /** Room shown in the panel (its details, or the open session's room). */
  openRoomId?: string | null;
  /** Tab click: also opens the room's details in the panel. */
  onOpenRoom?: (roomId: string) => void;
  /** Docked as a column left of the rooms (horizontal layout) instead of a row. */
  side?: boolean;
  /** List closed sessions too (dimmed) — on while a search is active, so a
   *  match in a closed session is reachable from the list. */
  includeClosed?: boolean;
  /** While searching: where the query matched per sessionId (labels under the name). */
  matchSources?: Record<string, SearchSource[]> | null;
}

/** `unseen` = waiting on you and not opened since; `seen` = waiting, already opened (or marked read/parked);
 *  `closed` = no live process (listed only while searching). */
type DotStatus = 'busy' | 'unseen' | 'seen' | 'idle' | 'closed';

interface SessionDot {
  /** overlordId when present — stable across /clear. */
  id: string;
  sessionId: string;
  name: string;
  status: DotStatus;
  /** Background command, Monitor watch, or scheduled wakeup in flight. */
  background: boolean;
  /** The session's colour when you picked one — unset for the default orange. */
  tint?: string;
  /** While searching: where the query matched. */
  sources?: SearchSource[];
  /** Group (tag) it is filed under in this list. */
  group?: string;
}

interface TabInfo {
  id: string;
  name: string;
  cwd: string;
  waiting: number;
  sessions: SessionDot[];
}

/** The default worker orange (hue 30, saturation 75%) at any lightness. */
const DEFAULT_COLOR_RE = /^hsl\(\s*30(?:\.0+)?\s*,\s*75(?:\.0+)?%/;
const customTint = (color: string | undefined) =>
  color && !DEFAULT_COLOR_RE.test(color) ? color : undefined;

const isWaiting = (s: Session) => isAgent(s) && s.state === 'waiting' && s.review == null;
const dotId = (s: Session) => s.overlordId ?? s.sessionId;

function sessionDots(sessions: Session[], customNames: Record<string, string>, includeClosed: boolean, matchSources?: Record<string, SearchSource[]> | null): SessionDot[] {
  const seen = new Set<string>();
  const out: SessionDot[] = [];
  for (const s of sessions) {
    if (s.state === 'closed' && !includeClosed) continue;
    const id = dotId(s);
    if (seen.has(id)) continue;
    seen.add(id);
    const status: DotStatus = s.state === 'closed' ? 'closed'
      : s.sessionType === 'note' ? 'seen' // a note is a standing to-do for you
      : isBusy(s) ? 'busy'
      // `review` ('read' / 'parked') is set when you open the session — see useMarkSeenOnOpen.
      // A finished turn is unseen even with a wakeup/background task pending,
      // and keeps the `seen` ring once read (the blue dot marks the background work).
      : turnEnded(s) ? (s.review == null ? 'unseen' : 'seen')
      : 'idle';
    out.push({
      id,
      sessionId: s.sessionId,
      name: customNames[s.sessionId] ?? s.proposedName ?? s.slug ?? s.sessionId.slice(0, 8),
      status,
      background: hasBackground(s),
      tint: customTint(s.color),
      ...(matchSources?.[s.sessionId]?.length ? { sources: matchSources[s.sessionId] } : {}),
      ...(s.group ? { group: s.group } : {}),
    });
  }
  return out;
}

const STATUS_LABEL: Record<DotStatus, string> = {
  busy: 'working',
  unseen: 'waiting for input — not seen yet',
  seen: 'waiting for input — seen',
  idle: 'idle',
  closed: 'closed',
};

function roomEl(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-room-id="${CSS.escape(id)}"]`);
}

const NO_NAMES: Record<string, string> = {};

/** Ungrouped sessions first, then each group in order of its first session. */
export function splitGroups(dots: SessionDot[]): { loose: SessionDot[]; groups: [string, SessionDot[]][] } {
  const loose: SessionDot[] = [];
  const groups = new Map<string, SessionDot[]>();
  for (const d of dots) {
    if (!d.group) { loose.push(d); continue; }
    const g = groups.get(d.group);
    if (g) g.push(d); else groups.set(d.group, [d]);
  }
  return { loose, groups: [...groups] };
}

interface GroupMenuState { x: number; y: number; roomId: string; sessionId: string; current?: string; naming?: 'new' | 'rename' }

/** Rooms whose session list is folded in the side list; per browser. */
const COLLAPSED_KEY = 'overlord:roomTabsCollapsed';
function readCollapsed(key = COLLAPSED_KEY): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export const RoomTabs = React.memo(function RoomTabs({
  rooms, archiveCounts, sessionCounts, onHide, scrollRef, onMove, showSessions = false, customNames = NO_NAMES, selectedSessionId, onSelectSession, openRoomId, onOpenRoom, side = false, includeClosed = false, matchSources,
}: RoomTabsProps) {
  // Session dots follow the desk order inside each room (drag order, then oldest first).
  const { getOrder } = useRoomOrder();
  // Snapshot ticks rebuild rooms; tabs only re-render when what they show changes.
  const tabsKey = rooms
    .map(r => {
      const waiting = r.sessions.filter(isWaiting).length;
      const dots = showSessions ? JSON.stringify(sessionDots(sortRoomSessions(r.sessions, getOrder(r.id)), customNames, includeClosed, matchSources)) : '[]';
      return `${r.id}\u0001${r.name}\u0001${r.cwd}\u0001${waiting}\u0001${dots}`;
    })
    .join('\u0002');
  const tabs = useMemo<TabInfo[]>(
    () => (tabsKey ? tabsKey.split('\u0002') : []).map(row => {
      const [id, name, cwd, waiting, dots] = row.split('\u0001');
      return { id, name, cwd, waiting: Number(waiting), sessions: JSON.parse(dots) as SessionDot[] };
    }),
    [tabsKey],
  );

  // The click handler needs the live Session object, not the memoized dot.
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const openSession = (roomId: string, sessionId: string) => {
    const session = roomsRef.current.find(r => r.id === roomId)?.sessions.find(s => s.sessionId === sessionId);
    if (session) onSelectSession?.(session);
  };

  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const toggleCollapsed = (id: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  const [groupsCollapsed, setGroupsCollapsed] = useState<Set<string>>(readCollapsedGroups);
  const toggleGroup = (key: string) => setGroupsCollapsed(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    writeCollapsedGroups(next);
    return next;
  });
  // A rename from the session menu moves the folded state in storage.
  useEffect(() => {
    const sync = () => setGroupsCollapsed(readCollapsedGroups());
    window.addEventListener(GROUPS_COLLAPSED_EVENT, sync);
    return () => window.removeEventListener(GROUPS_COLLAPSED_EVENT, sync);
  }, []);

  // Right-click on a session row: file it under a group.
  const [menu, setMenu] = useState<GroupMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);
  const fileUnder = (sessionId: string, group: string | null) => { setMenu(null); void putGroup(sessionId, group); };

  // Double-click on a group head renames it — every session in it moves along.
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameGroupAt = (roomId: string, dots: SessionDot[], from: string, to: string) => {
    setRenaming(null);
    setMenu(null);
    if (renameGroup(roomId, dots, from, to)) setGroupsCollapsed(readCollapsedGroups());
  };

  // Highlight the room whose top is closest to the scroll container's top edge.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = container.getBoundingClientRect().top;
      let best: { id: string; dist: number } | null = null;
      for (const t of tabs) {
        const el = roomEl(container, t.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom <= top + 24) continue; // scrolled past
        const dist = Math.abs(r.top - top);
        if (!best || dist < best.dist) best = { id: t.id, dist };
      }
      setActiveId(best?.id ?? null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tabs, scrollRef]);

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const endDrag = () => { setDraggedId(null); setDropTargetId(null); };

  if (tabs.length === 0) return null;

  const jump = (id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    expandRoom(id);
    setActiveId(id);
    // Expanding may reflow the grid — scroll on the next frame.
    requestAnimationFrame(() => {
      const el = roomEl(container, id);
      if (!el) return;
      const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTo({ top: container.scrollTop + offset - 12, behavior: 'smooth' });
    });
  };

  return (
    <nav className={`${styles.strip} ${side ? styles.side : ''}`} aria-label="Rooms">
      {tabs.map(t => {
        const hasSessions = showSessions && t.sessions.length > 0;
        const folded = hasSessions && collapsed.has(t.id);
        return (
        <div
          key={t.id}
          data-room-tab={t.id}
          className={[
            styles.tab,
            activeId === t.id ? styles.active : '',
            openRoomId === t.id ? styles.open : '',
            draggedId === t.id ? styles.dragging : '',
            dropTargetId === t.id ? styles.dropTarget : '',
            hasSessions && !folded ? styles.withSessions : '',
          ].filter(Boolean).join(' ')}
          onClick={() => { jump(t.id); onOpenRoom?.(t.id); }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', t.name);
            setDraggedId(t.id);
          }}
          onDragOver={(e) => {
            if (!draggedId) return; // not one of our tabs
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTargetId(t.id === draggedId ? null : t.id);
          }}
          onDragLeave={() => setDropTargetId(prev => (prev === t.id ? null : prev))}
          onDrop={(e) => {
            e.preventDefault();
            if (draggedId && draggedId !== t.id) onMove(draggedId, t.id);
            endDrag();
          }}
          onDragEnd={endDrag}
        >
          {hasSessions && (
            <button type="button" className={styles.foldBtn} draggable={false}
              aria-expanded={!folded}
              aria-label={`${folded ? 'Expand' : 'Collapse'} ${t.name}`}
              title={folded ? 'Show sessions' : 'Hide sessions'}
              onClick={e => { e.stopPropagation(); toggleCollapsed(t.id); }}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: folded ? 'rotate(-90deg)' : undefined }}>
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}
          {/* The badge is an overlay, so state changes never shift tab widths. */}
          <button type="button" className={styles.tabBtn} title={`${t.cwd}\n${(sessionCounts?.[t.id] ?? rooms.find(r => r.id === t.id)?.sessions.length ?? 0) + (archiveCounts?.[t.id] ?? 0)} sessions total\nDrag to reorder`}>
            <span className={styles.name}>{t.name}</span>
            {folded && <span className={styles.foldCount}>{t.sessions.length}</span>}
          </button>
          {onHide && <button type="button" className={styles.hideBtn}
            title="Hide room" aria-label={`Hide room ${t.name}`} draggable={false}
            onClick={e => { e.stopPropagation(); onHide(t.id, t.cwd); }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
              <path d="m2 2 12 12" />
            </svg>
          </button>}
          {hasSessions && !folded && (() => {
            const renderDot = (d: SessionDot) => (
                <React.Fragment key={d.id}>
                <button
                  type="button"
                  className={[
                    styles.session,
                    styles[d.status],
                    selectedSessionId === d.id || selectedSessionId === d.sessionId ? styles.selected : '',
                    d.tint ? styles.tinted : '',
                  ].filter(Boolean).join(' ')}
                  style={d.tint ? ({ '--tint': d.tint } as React.CSSProperties) : undefined}
                  title={`${d.name} — ${STATUS_LABEL[d.status]}${d.background ? ' · background task running' : ''}`}
                  draggable={false}
                  onClick={(e) => { e.stopPropagation(); openSession(t.id, d.sessionId); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, roomId: t.id, sessionId: d.sessionId, current: d.group });
                  }}
                >
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span className={styles.sessionName}>{d.name}</span>
                  {d.background && <span className={styles.bgDot} aria-hidden="true" />}
                </button>
                {d.sources && (
                  <span className={styles.matchSources} aria-label={`Matched in: ${d.sources.map(x => SOURCE_LABEL[x]).join(', ')}`}>
                    {d.sources.map(x => <span key={x} className={styles.matchSource} data-source={x}>{SOURCE_LABEL[x]}</span>)}
                  </span>
                )}
                </React.Fragment>
            );
            const { loose, groups } = splitGroups(t.sessions);
            return (
            <span className={styles.sessions}>
              {loose.map(renderDot)}
              {groups.map(([g, dots]) => {
                const key = groupKey(t.id, g);
                const gFolded = groupsCollapsed.has(key);
                const waiting = dots.some(d => d.status === 'unseen');
                return (
                  <span key={`g:${g}`} className={styles.group} data-group={g}>
                    {renaming === key ? (
                      <input className={styles.groupRename} autoFocus defaultValue={g} maxLength={40}
                        aria-label={`Rename group ${g}`}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') renameGroupAt(t.id, dots, g, e.currentTarget.value);
                          else if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={e => renameGroupAt(t.id, dots, g, e.currentTarget.value)} />
                    ) : (
                      <button type="button" className={styles.groupHead} draggable={false}
                        aria-expanded={!gFolded}
                        aria-label={`${gFolded ? 'Expand' : 'Collapse'} group ${g}`}
                        title={`${g} — double-click to rename`}
                        onClick={e => { e.stopPropagation(); toggleGroup(key); }}
                        onDoubleClick={e => { e.stopPropagation(); setRenaming(key); }}>
                        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                          style={{ transform: gFolded ? 'rotate(-90deg)' : undefined }} aria-hidden="true">
                          <polyline points="2 3.5 5 6.5 8 3.5" />
                        </svg>
                        <span className={styles.groupName}>{g}</span>
                        <span className={styles.groupCount}>{dots.length}</span>
                        {gFolded && waiting && <span className={styles.groupWaiting} aria-label="waiting for input" />}
                      </button>
                    )}
                    {!gFolded && <span className={styles.groupBody}>{dots.map(renderDot)}</span>}
                  </span>
                );
              })}
            </span>
            );
          })()}
          {/* The session list already shows who's waiting — the count is redundant. */}
          {t.waiting > 0 && !(hasSessions && !folded) && <span className={styles.badge} title={`${t.waiting} waiting for input`}>{t.waiting > 9 ? '9+' : t.waiting}</span>}
        </div>
        );
      })}
      {menu && createPortal(
        <div ref={menuRef} className={styles.groupMenu} role="menu" style={{ left: menu.x, top: menu.y }}>
          <div className={styles.groupMenuTitle}>Move to group</div>
          {(() => {
            const room = tabs.find(x => x.id === menu.roomId);
            const names = room ? splitGroups(room.sessions).groups.map(([g]) => g).filter(g => g !== menu.current) : [];
            return names.map(g => (
              <button key={g} type="button" role="menuitem" className={styles.groupMenuItem}
                onClick={() => fileUnder(menu.sessionId, g)}>{g}</button>
            ));
          })()}
          {menu.naming === 'new' ? (
            <input className={styles.groupMenuInput} autoFocus maxLength={40} placeholder="Group name"
              aria-label="New group name"
              onKeyDown={e => {
                if (e.key === 'Enter' && e.currentTarget.value.trim()) fileUnder(menu.sessionId, e.currentTarget.value.trim());
              }} />
          ) : (
            <button type="button" role="menuitem" className={styles.groupMenuItem}
              onClick={() => setMenu({ ...menu, naming: 'new' })}>New group…</button>
          )}
          {menu.current && (menu.naming === 'rename' ? (
            <input className={styles.groupMenuInput} autoFocus maxLength={40} defaultValue={menu.current}
              aria-label={`Rename group ${menu.current}`}
              onFocus={e => e.currentTarget.select()}
              onKeyDown={e => {
                if (e.key !== 'Enter' || !menu.current) return;
                const room = tabs.find(x => x.id === menu.roomId);
                renameGroupAt(menu.roomId, room?.sessions ?? [], menu.current, e.currentTarget.value);
              }} />
          ) : (
            <button type="button" role="menuitem" className={styles.groupMenuItem}
              onClick={() => setMenu({ ...menu, naming: 'rename' })}>Rename “{menu.current}”…</button>
          ))}
          {menu.current && (
            <button type="button" role="menuitem" className={`${styles.groupMenuItem} ${styles.groupMenuMuted}`}
              onClick={() => fileUnder(menu.sessionId, null)}>Remove from group</button>
          )}
        </div>,
        document.body,
      )}
    </nav>
  );
});
