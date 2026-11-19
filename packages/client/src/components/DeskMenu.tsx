import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import type { Session } from '../types';
import { ColorPicker } from './ColorPicker';
import { putSessionColor, putSessionIcon } from '../lib/sessionAppearance';
import { fetchShellHistoryLines, trimShellHistory, SHELL_HISTORY_KEEP_LINES } from '../lib/shellHistory';
import { groupNames, putGroup, renameGroup } from '../lib/sessionGroups';

/** Session burger menu — shared by the desk card (Room) and the detail panel header. */
export function DeskMenu({ onDelete, onClone, onClear, onArchive, onClose, onNewSession, getConversationText, sessionRef, session, roomId, roomSessions, anchorStyle, buttonSize = 22 }: {
  onDelete: () => void; onClone?: () => void; onClear?: () => void; onArchive?: () => void; onClose?: () => void;
  /** Adds a "New session here" item: quick spawn in the same room (detail panel only). */
  onNewSession?: () => void;
  /** Adds a "Copy conversation" item (detail panel only). */
  getConversationText?: () => string;
  sessionRef: string; session: Session;
  /** The session's room — enables the "Group" item (file under / rename a group). */
  roomId?: string; roomSessions?: Session[];
  /** Wrapper position; defaults to the desk card's top-right corner. */
  anchorStyle?: React.CSSProperties;
  buttonSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const burgerRef = React.useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<'ref' | 'conv' | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isRaw = session.sessionType === 'raw';
  // Shell history length, fetched each time the menu opens (raw sessions only).
  const [historyLines, setHistoryLines] = useState<number | null>(null);
  // "Group" swaps the menu body for the group picker; null = main items.
  const [groupView, setGroupView] = useState<null | 'list' | 'new' | 'rename'>(null);
  React.useEffect(() => { if (!open) setGroupView(null); }, [open]);
  const fileUnder = (group: string | null) => { setOpen(false); void putGroup(session.sessionId, group); };

  React.useEffect(() => {
    if (!open || !isRaw) { setHistoryLines(null); return; }
    let cancelled = false;
    void fetchShellHistoryLines(session.sessionId).then(n => { if (!cancelled) setHistoryLines(n); });
    return () => { cancelled = true; };
  }, [open, isRaw, session.sessionId]);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    // The menu is portaled with fixed coords — any scroll or resize would strand it.
    function dismiss(e: Event) {
      if (e.type === 'scroll' && menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  // Portaled to <body> so no panel/feed stacking context or overflow can cover it.
  // Opens downward; flips upward when the space below is too short.
  React.useLayoutEffect(() => {
    if (!open || !burgerRef.current) { setMenuPos(null); return; }
    const r = burgerRef.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    const MENU_H = 320;
    setMenuPos(window.innerHeight - r.bottom < MENU_H && r.top > window.innerHeight - r.bottom
      ? { bottom: window.innerHeight - r.top + 4, right }
      : { top: r.bottom + 4, right });
  }, [open]);

  React.useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const copy = (e: React.MouseEvent, what: 'ref' | 'conv', text: string) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text);
    setCopied(what);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => { setCopied(null); setOpen(false); }, 900);
  };
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setOpen(false); fn(); };

  return (
    <div ref={ref} style={anchorStyle ?? { position: 'absolute', top: 4, right: 4, zIndex: 10 }}>
      <button
        ref={burgerRef}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          background: 'rgba(30,30,40,0.85)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4, color: 'rgba(255,255,255,0.4)', width: buttonSize, height: buttonSize,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, opacity: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
        title="Options"
      >
        {/* "More" dots, not a burger: the app menu in the header is the burger. */}
        <svg width="12" height="4" viewBox="0 0 12 4" fill="currentColor">
          <circle cx="2" cy="2" r="1.3"/>
          <circle cx="6" cy="2" r="1.3"/>
          <circle cx="10" cy="2" r="1.3"/>
        </svg>
      </button>
      {open && menuPos && ReactDOM.createPortal(
        <div ref={menuRef} onMouseDown={(e) => e.stopPropagation()} style={{
          position: 'fixed', ...menuPos, background: '#1e1e2e',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 10000, minWidth: 140,
        }}>
          {groupView ? (
            <GroupPicker
              view={groupView}
              current={session.group}
              names={groupNames(roomSessions ?? []).filter(g => g !== session.group)}
              onView={setGroupView}
              onFile={fileUnder}
              onRename={(to) => {
                if (roomId && session.group) renameGroup(roomId, roomSessions ?? [], session.group, to);
                setOpen(false);
              }}
            />
          ) : <>
          {/* Most used first: Close and Archive lead the menu. */}
          {onClose && <MenuItem icon={ICONS.close} label="Close" onClick={act(onClose)} />}
          {onArchive && <MenuItem icon={ICONS.archive} label="Archive" onClick={act(onArchive)} />}
          {(onClose || onArchive) && <MenuDivider />}
          <MenuItem
            icon={copied === 'ref' ? ICONS.check : ICONS.copy}
            label={copied === 'ref' ? 'Copied' : 'Copy session ID'}
            title={sessionRef}
            done={copied === 'ref'}
            onClick={(e) => copy(e, 'ref', sessionRef)}
          />
          {getConversationText && (
            <MenuItem
              icon={copied === 'conv' ? ICONS.check : ICONS.conversation}
              label={copied === 'conv' ? 'Copied' : 'Copy conversation'}
              done={copied === 'conv'}
              onClick={(e) => copy(e, 'conv', getConversationText())}
            />
          )}
          <MenuItem icon={ICONS.palette} label="Icon & color…" onClick={act(() => setAppearanceOpen(true))} />
          {roomId && roomSessions && (
            <MenuItem icon={ICONS.group} label="Group…" hint={session.group}
              title="File this session under a group in the side room list"
              onClick={(e) => { e.stopPropagation(); setGroupView('list'); }} />
          )}
          {onNewSession && <MenuItem icon={ICONS.newSession} label="New session here" title="Quick spawn in this room and switch to it" hover="#d4af37" hoverBg="rgba(212,175,55,0.1)" onClick={act(onNewSession)} />}
          {onClone && <MenuItem icon={ICONS.clone} label="Clone" hover="#d4af37" hoverBg="rgba(212,175,55,0.1)" onClick={act(onClone)} />}
          {onClear && <MenuItem icon={ICONS.clear} label="Clear" hover="#fb923c" hoverBg="rgba(251,146,60,0.1)" onClick={act(onClear)} />}
          {historyLines !== null && historyLines > SHELL_HISTORY_KEEP_LINES && (
            <MenuItem
              icon={ICONS.trim}
              label={`Trim history to last ${SHELL_HISTORY_KEEP_LINES} lines`}
              hint={`${historyLines.toLocaleString()} lines`}
              title="Older output is deleted for good; the shell keeps running"
              hover="#fb923c" hoverBg="rgba(251,146,60,0.1)"
              onClick={act(() => { void trimShellHistory(session.sessionId, session.overlordId ?? session.sessionId); })}
            />
          )}
          <MenuDivider />
          <MenuItem icon={ICONS.trash} label="Delete" color="#ff6b6b" hover="#ff6b6b" hoverBg="rgba(255,107,107,0.1)" onClick={act(onDelete)} />
          </>}
        </div>,
        document.body,
      )}
      <ColorPicker
        sessionId={session.sessionId}
        color={session.color}
        icon={session.icon}
        isRaw={isRaw}
        anchorRef={burgerRef}
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
        onChange={(c) => putSessionColor(session.sessionId, c)}
        onIconChange={(i) => putSessionIcon(session.sessionId, i)}
      />
    </div>
  );
}

const svg = (d: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

const ICONS = {
  close: svg(<><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></>),
  archive: svg(<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>),
  copy: svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>),
  conversation: svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />),
  palette: svg(<><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8z" /><circle cx="7.5" cy="10.5" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16.5" cy="10.5" r="1" /></>),
  clone: svg(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a1 1 0 0 1 1-1h11M14.5 11.5v6M11.5 14.5h6" /></>),
  clear: svg(<path d="M3 6h18M7 12h10M10 18h4" />),
  newSession: svg(<><path d="M7 3v8M3 7h8" /><path d="M16 4l-4 8h5l-3 8" /></>),
  trash: svg(<><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" /></>),
  check: svg(<path d="M5 12l5 5L20 7" />),
  trim: svg(<><path d="M4 6h16M4 10h16" /><path d="M4 15h10M4 19h6" strokeDasharray="2 3" /></>),
  group: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>),
  back: svg(<path d="M15 18l-6-6 6-6" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  pencil: svg(<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />),
  ungroup: svg(<path d="M6 6l12 12M18 6L6 18" />),
};

/** The "Group" view of the session menu: file under an existing / new group, rename the current one, or ungroup. */
function GroupPicker({ view, current, names, onView, onFile, onRename }: {
  view: 'list' | 'new' | 'rename'; current?: string; names: string[];
  onView: (v: 'list' | 'new' | 'rename' | null) => void;
  onFile: (group: string | null) => void;
  onRename: (to: string) => void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <>
      <MenuItem icon={ICONS.back} label={current ? `Group: ${current}` : 'Move to group'} color="rgba(255,255,255,0.45)" onClick={stop(() => onView(null))} />
      <MenuDivider />
      {names.map(g => <MenuItem key={g} icon={ICONS.group} label={g} onClick={stop(() => onFile(g))} />)}
      {view === 'new'
        ? <MenuInput label="New group name" placeholder="Group name" onSubmit={v => onFile(v)} onCancel={() => onView('list')} />
        : <MenuItem icon={ICONS.plus} label="New group…" onClick={stop(() => onView('new'))} />}
      {current && (view === 'rename'
        ? <MenuInput label={`Rename group ${current}`} initial={current} onSubmit={onRename} onCancel={() => onView('list')} />
        : <MenuItem icon={ICONS.pencil} label={`Rename “${current}”…`} title="Renames the group for every session in it" onClick={stop(() => onView('rename'))} />)}
      {current && <MenuItem icon={ICONS.ungroup} label="Remove from group" color="rgba(255,255,255,0.45)" onClick={stop(() => onFile(null))} />}
    </>
  );
}

function MenuInput({ label, placeholder, initial, onSubmit, onCancel }: {
  label: string; placeholder?: string; initial?: string;
  onSubmit: (value: string) => void; onCancel: () => void;
}) {
  return (
    <input
      autoFocus maxLength={40} aria-label={label} placeholder={placeholder} defaultValue={initial}
      onFocus={e => e.currentTarget.select()}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
        else if (e.key === 'Enter' && e.currentTarget.value.trim()) onSubmit(e.currentTarget.value.trim());
      }}
      style={{
        display: 'block', width: 'calc(100% - 8px)', margin: '3px 4px', padding: '5px 8px', boxSizing: 'border-box',
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 5,
        color: '#fff', fontSize: 13, outline: 'none',
      }}
    />
  );
}

const MENU_TEXT = 'rgba(255,255,255,0.7)';

function MenuItem({ icon, label, hint, title, onClick, done, color = MENU_TEXT, hover = '#cbd5e1', hoverBg = 'rgba(148,163,184,0.15)' }: {
  icon: React.ReactNode; label: string; hint?: string; title?: string; onClick: (e: React.MouseEvent) => void;
  /** Transient success state (after a copy) — green, no hover recolor. */
  done?: boolean; color?: string; hover?: string; hoverBg?: string;
}) {
  const base = done ? '#22c55e' : color;
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 12px',
        background: 'none', border: 'none', borderRadius: 5, color: base,
        fontSize: 13, textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hoverBg; if (!done) e.currentTarget.style.color = hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = base; }}
    >
      <span style={{ display: 'flex', opacity: 0.85, flexShrink: 0 }}>{icon}</span>
      {label}
      {hint && <span style={{ marginLeft: 'auto', paddingLeft: 16, fontSize: 11, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>{hint}</span>}
    </button>
  );
}

const MenuDivider = () => <div style={{ height: 1, margin: '4px 6px', background: 'rgba(255,255,255,0.08)' }} />;
