import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import type { Session } from '../types';
import { ColorPicker } from './ColorPicker';
import { putSessionColor, putSessionIcon } from '../lib/sessionAppearance';

/** Session burger menu — shared by the desk card (Room) and the detail panel header. */
export function DeskMenu({ onDelete, onClone, onClear, onArchive, onClose, getConversationText, sessionRef, session, anchorStyle, buttonSize = 22 }: {
  onDelete: () => void; onClone?: () => void; onClear?: () => void; onArchive?: () => void; onClose?: () => void;
  /** Adds a "Copy conversation" item (detail panel only). */
  getConversationText?: () => string;
  sessionRef: string; session: Session;
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
        <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor">
          <rect y="0" width="12" height="1.5" rx="0.75"/>
          <rect y="4.25" width="12" height="1.5" rx="0.75"/>
          <rect y="8.5" width="12" height="1.5" rx="0.75"/>
        </svg>
      </button>
      {open && menuPos && ReactDOM.createPortal(
        <div ref={menuRef} onMouseDown={(e) => e.stopPropagation()} style={{
          position: 'fixed', ...menuPos, background: '#1e1e2e',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 10000, minWidth: 140,
        }}>
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
          {onClone && <MenuItem icon={ICONS.clone} label="Clone" hover="#d4af37" hoverBg="rgba(212,175,55,0.1)" onClick={act(onClone)} />}
          {onClear && <MenuItem icon={ICONS.clear} label="Clear" hover="#fb923c" hoverBg="rgba(251,146,60,0.1)" onClick={act(onClear)} />}
          <MenuDivider />
          <MenuItem icon={ICONS.trash} label="Delete" color="#ff6b6b" hover="#ff6b6b" hoverBg="rgba(255,107,107,0.1)" onClick={act(onDelete)} />
        </div>,
        document.body,
      )}
      <ColorPicker
        sessionId={session.sessionId}
        color={session.color}
        icon={session.icon}
        isRaw={session.sessionType === 'raw'}
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
  trash: svg(<><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" /></>),
  check: svg(<path d="M5 12l5 5L20 7" />),
};

const MENU_TEXT = 'rgba(255,255,255,0.7)';

function MenuItem({ icon, label, title, onClick, done, color = MENU_TEXT, hover = '#cbd5e1', hoverBg = 'rgba(148,163,184,0.15)' }: {
  icon: React.ReactNode; label: string; title?: string; onClick: (e: React.MouseEvent) => void;
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
    </button>
  );
}

const MenuDivider = () => <div style={{ height: 1, margin: '4px 6px', background: 'rgba(255,255,255,0.08)' }} />;
