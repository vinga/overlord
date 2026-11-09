import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Room } from '../types';
import panelStyles from './PtyTerminalPanel.module.css';
import styles from './RoomPanel.module.css';
import { BrainTab } from './BrainTab';
import { RoomDetailsTab } from './RoomDetailsTab';
import { RoomPlansTab } from './RoomDetailsTab';
import { PinBar, hiddenPinRefs } from './PinBar';
import { RoomGitInfo } from './RoomGitInfo';
import { GitSyncStatus } from './GitSyncStatus';
import { RoomFilesPanel } from './RoomFilesPanel';
import { OPEN_ROOM_TAB_EVENT, takeRoomTab, type RoomPanelTab } from '../lib/roomPanelTab';
import { ROOM_GRID_ENABLED } from '../config/featureFlags';

// Same sizing and storage keys as DetailPanel / NotePanel so panel size
// persists across panel types.
const WIDTH_KEY = 'overlord:panelWidth';
const HEIGHT_KEY = 'overlord:panelHeight';
const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 240;

type Tab = RoomPanelTab;

const TABS: { id: Tab; label: string }[] = [
  { id: 'room', label: 'Sessions' },
  { id: 'archive', label: 'Archive' },
  { id: 'files', label: 'Files' },
  { id: 'details', label: 'Notes' },
  { id: 'plans', label: 'Plans' },
  { id: 'brain', label: 'Brain' },
];

interface RoomPanelProps {
  room: Room;
  archivedCount?: number;
  customNames: Record<string, string>;
  onClose: () => void;
  dock?: 'right' | 'bottom';
  panelSize: number;
  onPanelSizeChange: (size: number) => void;
  /** The room card from the office, shown in the Room tab. */
  roomView?: ReactNode;
}

/** Room details docked in the session panel's slot — shown when a room is
 *  selected and no session is open. */
export function RoomPanel({ room, archivedCount, customNames, onClose, dock = 'right', panelSize, onPanelSizeChange, roomView }: RoomPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>(() => takeRoomTab(room.id) ?? 'room');
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

  // No room grid: fill the office under its header, like the session panel,
  // with a context column on the right of the tabs.
  const fillsOffice = !ROOM_GRID_ENABLED && horizontal;

  return (
    // Opens without the slide-in: it swaps in place of the session panel.
    <div
      className={`${panelStyles.panel} ${dock === 'bottom' ? panelStyles.panelBottom : fillsOffice ? styles.panelFill : ''} ${panelStyles.panelOpen}`}
      style={dock === 'bottom' ? { height: panelSize } : fillsOffice ? undefined : { width: panelSize }}
      aria-label={`Room ${room.name}`}
    >
      {!fillsOffice && <div
        className={`${panelStyles.resizeHandle} ${dock === 'bottom' ? panelStyles.resizeHandleTop : ''}`}
        onMouseDown={onResizeStart}
      />}

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
            {!fillsOffice && <span className={styles.sessionCounts}>
              {room.sessions.filter(s => s.state !== 'closed').length} active · {archivedCount ?? 0} archived
            </span>}
          </div>
        </div>
        {/* Filling the office there is nothing behind the panel to go back to. */}
        {!fillsOffice && <button className={styles.closeBtn} onClick={onClose} title="Close room details" aria-label="Close room details">✕</button>}
      </div>

      {!fillsOffice && <RoomGitInfo
        branch={room.gitBranch}
        gitAhead={room.gitAhead}
        pullRequest={room.pullRequest}
        gitWarning={room.gitWarning}
      />}

      {!fillsOffice && <PinBar pins={room.pins} cwd={room.cwd} hide={hiddenPinRefs(undefined, undefined, room.pullRequest?.url)} />}

      <div className={fillsOffice ? styles.tabsWithContext : styles.tabsPlain}>
      <div className={styles.tabsColumn}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.id === 'room' && (
              <span className={styles.tabCount} title="Active / all sessions">
                {room.sessions.filter(s => s.state !== 'closed').length}/{room.sessions.length}
              </span>
            )}
            {t.id === 'archive' && !!archivedCount && <span className={styles.tabCount}>{archivedCount}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={`${styles.content} ${activeTab === 'files' ? styles.contentFill : ''}`}>
        {activeTab === 'brain' && <BrainTab cwd={room.cwd} />}
        {activeTab === 'details' && <RoomDetailsTab cwd={room.cwd} />}
        {activeTab === 'room' && <div className={styles.roomView}>{roomView}</div>}
        {/* Same Room element, archive list only (Room's `view` prop). */}
        {activeTab === 'archive' && (
          <div className={styles.roomView}>
            {isValidElement<{ view?: 'desks' | 'archive' }>(roomView) ? cloneElement(roomView, { view: 'archive' }) : null}
          </div>
        )}
        {activeTab === 'files' && (
          <RoomFilesPanel cwd={room.cwd} hasPr={!!room.pullRequest} stacked={horizontal && !fillsOffice && panelSize < 640} />
        )}
        {activeTab === 'plans' && (
          <RoomPlansTab cwd={room.cwd} sessions={room.sessions} customNames={customNames} />
        )}
      </div>
      </div>{/* tabsColumn */}
      {fillsOffice && (
        // Room context: branch and PR, then the room's pins.
        <aside className={styles.contextColumn} aria-label="Room context">
          <div className={styles.contextField}>
            <span className={styles.contextFieldLabel}>Sessions</span>
            <span>{room.sessions.filter(s => s.state !== 'closed').length} active · {archivedCount ?? 0} archived</span>
          </div>
          <div className={styles.contextGit}>
            <RoomGitInfo
              branch={room.gitBranch}
              gitAhead={room.gitAhead}
              pullRequest={room.pullRequest}
              gitWarning={room.gitWarning}
            />
            {room.gitBranch && <GitSyncStatus gitAhead={room.gitAhead} gitBehind={room.gitBehind} gitUpstream={room.gitUpstream} gitDirty={room.gitDirty} />}
          </div>
          {!!room.pins?.length && <>
            <h3 className={styles.contextLabel}>Pins</h3>
            <PinBar pins={room.pins} cwd={room.cwd} multiline hide={hiddenPinRefs(undefined, undefined, room.pullRequest?.url)} />
          </>}
        </aside>
      )}
      </div>{/* tabsWithContext */}
    </div>
  );
}
