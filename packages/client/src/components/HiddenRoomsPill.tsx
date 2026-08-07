import React, { useEffect, useRef, useState } from 'react';
import type { Room } from '../types';
import styles from './HiddenRoomsPill.module.css';

interface HiddenRoomsPillProps {
  hiddenRooms: Room[];
  /** Sessions in hidden rooms currently waiting for input (unreviewed). */
  attentionCount: number;
  onUnhide: (roomId: string, cwd?: string) => void;
  onUnhideAll: () => void;
}

function EyeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  );
}

function EyeOffIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.8" />
      <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" />
    </svg>
  );
}

function roomHasAttention(room: Room): boolean {
  return room.sessions.some(s => s.state === 'waiting' && s.review == null);
}

export function HiddenRoomsPill({ hiddenRooms, attentionCount, onUnhide, onUnhideAll }: HiddenRoomsPillProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (hiddenRooms.length === 0) return null;

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        className={styles.pill}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`Hidden rooms: ${hiddenRooms.length}`}
        data-tooltip={attentionCount > 0
          ? `${hiddenRooms.length} hidden room${hiddenRooms.length === 1 ? '' : 's'} — ${attentionCount} waiting for input`
          : `${hiddenRooms.length} hidden room${hiddenRooms.length === 1 ? '' : 's'}`}
        data-tooltip-dir="down"
      >
        <EyeOffIcon />
        <span>{hiddenRooms.length}</span>
        {attentionCount > 0 && <span className={styles.attentionDot} aria-label={`${attentionCount} waiting`} />}
      </button>
      {open && (
        <div className={styles.popover} role="menu">
          <div className={styles.popoverTitle}>Hidden rooms</div>
          {hiddenRooms.map(room => {
            const activeCount = room.sessions.filter(s => s.state !== 'closed').length;
            const dotColor = room.sessions[0]?.color ?? 'rgba(212, 175, 55, 0.8)';
            return (
              <button
                key={room.id}
                className={styles.row}
                role="menuitem"
                onClick={() => onUnhide(room.id, room.cwd)}
                title={room.cwd}
              >
                <span className={styles.roomDot} style={{ background: dotColor }} />
                <span className={styles.rowName}>{room.name}</span>
                {roomHasAttention(room) && <span className={styles.rowAttentionDot} />}
                <span className={styles.rowCount}>{activeCount} {activeCount === 1 ? 'agent' : 'agents'}</span>
                <span className={styles.rowEye} aria-hidden="true"><EyeIcon /></span>
              </button>
            );
          })}
          <div className={styles.footer}>
            <button className={styles.showAllBtn} onClick={() => { onUnhideAll(); setOpen(false); }}>
              Show all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
