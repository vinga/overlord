import React, { useState } from 'react';
import type { Room, Session } from '../types';
import styles from './TaskListPanel.module.css';
import { BrainTab } from './BrainTab';
import { RoomDetailsTab } from './RoomDetailsTab';
import { RoomPlansTab } from './RoomDetailsTab';

type Tab = 'agents' | 'brain' | 'details' | 'plans';

interface TaskListPanelProps {
  room: Room;
  customNames: Record<string, string>;
  onSelectSession: (session: Session, timestamp?: string, query?: string) => void;
  onClose: () => void;
  panelWidth: number;
  onPanelWidthChange: (w: number) => void;
}

function getSessionDisplayName(session: Session, customNames: Record<string, string>): string {
  return customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const STATE_COLOR: Record<string, string> = {
  working: '#a78bfa',
  thinking: '#a78bfa',
  waiting: '#f59e0b',
  idle: '#374151',
};

const STATE_ICON: Record<string, string> = {
  working: '⚡',
  thinking: '◌',
  waiting: '…',
  idle: '○',
};

export function TaskListPanel({ room, customNames, onSelectSession, onClose, panelWidth, onPanelWidthChange }: TaskListPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('details');
  const isResizingRef = React.useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidth;
    function onMove(ev: MouseEvent) {
      const delta = startX - ev.clientX;
      onPanelWidthChange(Math.max(320, Math.min(900, startWidth + delta)));
    }
    function onUp() {
      isResizingRef.current = false;
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const roomSessions = room.sessions;
  const allSessions = roomSessions.map(s => ({ session: s }));

  // ── Agents tab data ──────────────────────────────────────────────────────
  const agentRows = allSessions
    .filter(({ session }) => session.state !== 'closed')
    .sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime());

  function handleSelect(session: Session) {
    onSelectSession(session);
  }

  return (
    <div className={`${styles.panel} ${isResizing ? styles.resizing : ''}`} style={{ width: panelWidth }}>
      <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />

      {/* Room identity header */}
      <div className={styles.panelHeader}>
        <div className={styles.headerWithIcon}>
          <svg className={styles.roomIcon} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="folderGrad" x1="4" y1="12" x2="36" y2="35" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#d4af37" />
                <stop offset="100%" stopColor="#ffffff" />
              </linearGradient>
            </defs>
            <path d="M4 14c0-1.1.9-2 2-2h8l3 3h17a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V14z" fill="url(#folderGrad)" stroke="url(#folderGrad)" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M4 17h32" stroke="rgba(0,0,0,0.2)" strokeWidth="1"/>
          </svg>
          <div className={styles.headerMain}>
            <h2 className={styles.roomTitle}>{room.name}</h2>
            <span className={styles.roomPath}>{room.cwd}</span>
          </div>
        </div>
        <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
      </div>

      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${activeTab === 'details' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('details')}
        >
          Details
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'plans' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('plans')}
        >
          Plans
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'brain' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('brain')}
        >
          Brain
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'agents' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          Agents
        </button>
      </div>

      {/* Content */}
      <div className={styles.content}>

        {/* ── AGENTS TAB ── */}
        {activeTab === 'agents' && (
          agentRows.length === 0
            ? <div className={styles.empty}>No active agents</div>
            : agentRows.map(({ session }) => {
                const isDone = session.state === 'waiting' && session.completionHint === 'done';
                const dotColor = isDone ? '#22c55e' : STATE_COLOR[session.state] ?? '#6b7280';
                const icon = isDone ? '✓' : STATE_ICON[session.state] ?? '○';
                const text = session.lastMessage?.slice(0, 120) ?? `${session.state}…`;
                const activeSubagents = session.subagents.filter(s => s.state === 'working' || s.state === 'thinking');
                return (
                  <div
                    key={session.sessionId}
                    className={styles.row}
                    onClick={() => handleSelect(session)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleSelect(session); }}
                  >
                    <span className={styles.rowIcon} style={{ color: dotColor }}>{icon}</span>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>
                        {getSessionDisplayName(session, customNames)}
                        {activeSubagents.length > 0 && (
                          <span className={styles.badge} style={{ color: '#a78bfa' }}>↗{activeSubagents.length}</span>
                        )}
                        {session.needsPermission && (
                          <span className={styles.badge} style={{ color: '#f59e0b' }}>⚠</span>
                        )}
                      </div>
                      <div className={styles.rowText}>{text}</div>
                      <div className={styles.rowMeta}>
                        <span className={styles.metaTime}>{relativeTime(session.lastActivity)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
        )}

        {/* ── BRAIN TAB ── */}
        {activeTab === 'brain' && (
          <BrainTab cwd={room.cwd} />
        )}

        {/* ── DETAILS TAB ── */}
        {activeTab === 'details' && (
          <RoomDetailsTab cwd={room.cwd} />
        )}

        {/* ── PLANS TAB ── */}
        {activeTab === 'plans' && (
          <RoomPlansTab cwd={room.cwd} sessions={room.sessions} customNames={customNames} />
        )}
      </div>
    </div>
  );
}
