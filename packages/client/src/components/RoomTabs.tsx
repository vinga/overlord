import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Room, Session } from '../types';
import { expandRoom } from '../hooks/useRoomCollapsed';
import { useRoomOrder } from '../hooks/useRoomOrder';
import { sortRoomSessions } from '../lib/roomSessionOrder';
import { hasBackground, isAgent, isBusy, turnEnded } from '../lib/sessionAttention';
import { SOURCE_LABEL, type SearchSource } from '../lib/searchSources';
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
      {tabs.map(t => (
        <div
          key={t.id}
          data-room-tab={t.id}
          className={[
            styles.tab,
            activeId === t.id ? styles.active : '',
            openRoomId === t.id ? styles.open : '',
            draggedId === t.id ? styles.dragging : '',
            dropTargetId === t.id ? styles.dropTarget : '',
            showSessions && t.sessions.length > 0 ? styles.withSessions : '',
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
          {/* The badge is an overlay, so state changes never shift tab widths. */}
          <button type="button" className={styles.tabBtn} title={`${t.cwd}\n${(sessionCounts?.[t.id] ?? rooms.find(r => r.id === t.id)?.sessions.length ?? 0) + (archiveCounts?.[t.id] ?? 0)} sessions total\nDrag to reorder`}>
            <span className={styles.name}>{t.name}</span>
          </button>
          {onHide && <button type="button" className={styles.hideBtn}
            title="Hide room" aria-label={`Hide room ${t.name}`} draggable={false}
            onClick={e => { e.stopPropagation(); onHide(t.id, t.cwd); }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
              <path d="m2 2 12 12" />
            </svg>
          </button>}
          {showSessions && t.sessions.length > 0 && (
            <span className={styles.sessions}>
              {t.sessions.map(d => (
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
              ))}
            </span>
          )}
          {/* The session list already shows who's waiting — the count is redundant. */}
          {t.waiting > 0 && !(showSessions && t.sessions.length > 0) && <span className={styles.badge} title={`${t.waiting} waiting for input`}>{t.waiting > 9 ? '9+' : t.waiting}</span>}
        </div>
      ))}
    </nav>
  );
});
