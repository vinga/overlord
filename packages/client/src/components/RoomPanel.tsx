import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from '../types';
import panelStyles from './PtyTerminalPanel.module.css';
import styles from './RoomPanel.module.css';
import { BrainTab } from './BrainTab';
import { RoomDetailsTab } from './RoomDetailsTab';
import { RoomPlansTab } from './RoomDetailsTab';
import { PinBar } from './PinBar';
import { RoomGitInfo } from './RoomGitInfo';
import { RoomFilesPanel } from './RoomFilesPanel';
import { OPEN_ROOM_TAB_EVENT, takeRoomTab, type RoomPanelTab } from '../lib/roomPanelTab';

// Same sizing and storage keys as DetailPanel / NotePanel so panel size
// persists across panel types.
const WIDTH_KEY = 'overlord:panelWidth';
const HEIGHT_KEY = 'overlord:panelHeight';
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 240;

type Tab = RoomPanelTab;

const TABS: { id: Tab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'files', label: 'Files' },
  { id: 'plans', label: 'Plans' },
  { id: 'brain', label: 'Brain' },
];

interface RoomPanelProps {
  room: Room;
  customNames: Record<string, string>;
  onClose: () => void;
  dock?: 'right' | 'bottom';
  panelSize: number;
  onPanelSizeChange: (size: number) => void;
}

/** Room details docked in the session panel's slot — shown when a room is
 *  selected and no session is open. */
export function RoomPanel({ room, customNames, onClose, dock = 'right', panelSize, onPanelSizeChange }: RoomPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>(() => takeRoomTab(room.id) ?? 'details');
  const horizontal = dock !== 'bottom';

  // A request for this room while it is already shown (folder button, "Show in Files").
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const tab = takeRoomTab(room.id);
      if (tab && (ev as CustomEvent<{ roomId: string }>).detail?.roomId === room.id) setActiveTab(tab);
    };
    window.addEventListener(OPEN_ROOM_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ROOM_TAB_EVENT, onOpen);
  }, [room.id]);

  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startPos.current = horizontal ? e.clientX : e.clientY;
    startSize.current = panelSize;
    document.body.style.cursor = horizontal ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [panelSize, horizontal]);

  useEffect(() => {
    const min = horizontal ? MIN_WIDTH : MIN_HEIGHT;
    const max = horizontal ? MAX_WIDTH : Math.max(MIN_HEIGHT, window.innerHeight - 160);
    let last = panelSize;
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startPos.current - (horizontal ? e.clientX : e.clientY);
      last = Math.max(min, Math.min(max, startSize.current + delta));
      onPanelSizeChange(last);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(horizontal ? WIDTH_KEY : HEIGHT_KEY, String(last)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizontal, onPanelSizeChange]);

  return (
    // Opens without the slide-in: it swaps in place of the session panel.
    <div
      className={`${panelStyles.panel} ${dock === 'bottom' ? panelStyles.panelBottom : ''} ${panelStyles.panelOpen}`}
      style={dock === 'bottom' ? { height: panelSize } : { width: panelSize }}
      aria-label={`Room ${room.name}`}
    >
      <div
        className={`${panelStyles.resizeHandle} ${dock === 'bottom' ? panelStyles.resizeHandleTop : ''}`}
        onMouseDown={onResizeStart}
      />

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
        <button className={styles.closeBtn} onClick={onClose} title="Close room details" aria-label="Close room details">✕</button>
      </div>

      <RoomGitInfo
        branch={room.gitBranch}
        gitAhead={room.gitAhead}
        pullRequest={room.pullRequest}
        gitWarning={room.gitWarning}
      />

      <PinBar pins={room.pins} cwd={room.cwd} />

      {/* Tab bar */}
      <div className={styles.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={`${styles.content} ${activeTab === 'files' ? styles.contentFill : ''}`}>
        {activeTab === 'brain' && <BrainTab cwd={room.cwd} />}
        {activeTab === 'details' && <RoomDetailsTab cwd={room.cwd} />}
        {activeTab === 'files' && (
          <RoomFilesPanel cwd={room.cwd} hasPr={!!room.pullRequest} stacked={horizontal && panelSize < 640} />
        )}
        {activeTab === 'plans' && (
          <RoomPlansTab cwd={room.cwd} sessions={room.sessions} customNames={customNames} />
        )}
      </div>
    </div>
  );
}
