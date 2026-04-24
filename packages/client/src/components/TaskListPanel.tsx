import { useState, useEffect } from 'react';
import type { Room, Session } from '../types';
import styles from './TaskListPanel.module.css';
import { BrainTab } from './BrainTab';
import { RoomDetailsTab } from './RoomDetailsTab';
import { RoomPlansTab } from './RoomDetailsTab';

type Tab = 'brain' | 'details' | 'plans';

interface TaskListPanelProps {
  room: Room;
  customNames: Record<string, string>;
  onSelectSession: (session: Session, timestamp?: string, query?: string) => void;
  onClose: () => void;
}

export function TaskListPanel({ room, customNames, onClose }: TaskListPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('details');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
    <div className={styles.panel} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">

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
      </div>

      {/* Content */}
      <div className={styles.content}>

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
    </div>
  );
}
