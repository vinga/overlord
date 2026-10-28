import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Room, Session } from '../types';
import { expandRoom } from '../hooks/useRoomCollapsed';
import { hasBackground, isAgent, isBusy, needsUser } from '../lib/sessionAttention';
import styles from './RoomTabs.module.css';

interface RoomTabsProps {
  rooms: Room[];
  /** The scrolling grid container — tabs scroll it and track which room is on top. */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Drag-to-reorder: moves `draggedId` in front of `targetId` (shared room order). */
  onMove: (draggedId: string, targetId: string) => void;
  /** Settings toggle: list each room's open sessions as clickable dots. */
  showSessions?: boolean;
  customNames?: Record<string, string>;
  selectedSessionId?: string | null;
  onSelectSession?: (session: Session) => void;
  /** Docked as a column left of the rooms (horizontal layout) instead of a row. */
  side?: boolean;
}

/** `unseen` = waiting on you and not opened since; `seen` = waiting, already opened (or marked read/parked). */
type DotStatus = 'busy' | 'unseen' | 'seen' | 'idle';

interface SessionDot {
  /** overlordId when present — stable across /clear. */
  id: string;
  sessionId: string;
  name: string;
  status: DotStatus;
  /** Background command, Monitor watch, or scheduled wakeup in flight. */
  background: boolean;
}

interface TabInfo {
  id: string;
  name: string;
  cwd: string;
  waiting: number;
  sessions: SessionDot[];
}

const isWaiting = (s: Session) => isAgent(s) && s.state === 'waiting' && s.review == null;
const dotId = (s: Session) => s.overlordId ?? s.sessionId;

function sessionDots(sessions: Session[], customNames: Record<string, string>): SessionDot[] {
  const seen = new Set<string>();
  const out: SessionDot[] = [];
  for (const s of sessions) {
    if (s.state === 'closed') continue;
    const id = dotId(s);
    if (seen.has(id)) continue;
    seen.add(id);
    const status: DotStatus = isBusy(s) ? 'busy'
      // `review` ('read' / 'parked') is set when you open the session — see useMarkSeenOnOpen.
      : needsUser(s) ? (s.review == null ? 'unseen' : 'seen')
      : 'idle';
    out.push({
      id,
      sessionId: s.sessionId,
      name: customNames[s.sessionId] ?? s.proposedName ?? s.slug ?? s.sessionId.slice(0, 8),
      status,
      background: hasBackground(s),
    });
  }
  return out;
}

const STATUS_LABEL: Record<DotStatus, string> = {
  busy: 'working',
  unseen: 'waiting for input — not seen yet',
  seen: 'waiting for input — seen',
  idle: 'idle',
};

function roomEl(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-room-id="${CSS.escape(id)}"]`);
}

const NO_NAMES: Record<string, string> = {};

export const RoomTabs = React.memo(function RoomTabs({
  rooms, scrollRef, onMove, showSessions = false, customNames = NO_NAMES, selectedSessionId, onSelectSession, side = false,
}: RoomTabsProps) {
  // Snapshot ticks rebuild rooms; tabs only re-render when what they show changes.
  const tabsKey = rooms
    .map(r => {
      const waiting = r.sessions.filter(isWaiting).length;
      const dots = showSessions ? JSON.stringify(sessionDots(r.sessions, customNames)) : '[]';
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

  if (tabs.length < 2) return null;

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
            draggedId === t.id ? styles.dragging : '',
            dropTargetId === t.id ? styles.dropTarget : '',
            showSessions && t.sessions.length > 0 ? styles.withSessions : '',
          ].filter(Boolean).join(' ')}
          onClick={() => jump(t.id)}
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
          <button type="button" className={styles.tabBtn} title={`${t.cwd}\nDrag to reorder`}>
            <span className={styles.name}>{t.name}</span>
          </button>
          {showSessions && t.sessions.length > 0 && (
            <span className={styles.sessions}>
              {t.sessions.map(d => (
                <button
                  key={d.id}
                  type="button"
                  className={[
                    styles.session,
                    styles[d.status],
                    selectedSessionId === d.id || selectedSessionId === d.sessionId ? styles.selected : '',
                  ].filter(Boolean).join(' ')}
                  title={`${d.name} — ${STATUS_LABEL[d.status]}${d.background ? ' · background task running' : ''}`}
                  draggable={false}
                  onClick={(e) => { e.stopPropagation(); openSession(t.id, d.sessionId); }}
                >
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span className={styles.sessionName}>{d.name}</span>
                  {d.background && <span className={styles.bgDot} aria-hidden="true" />}
                </button>
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
