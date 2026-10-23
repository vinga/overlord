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
    const MENU_H = 240;
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
  const copyItemStyle = (done: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', padding: '8px 14px',
    background: 'none', border: 'none', color: done ? '#22c55e' : 'rgba(255,255,255,0.7)',
    fontSize: 13, textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
  });

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
          <button
            onClick={(e) => copy(e, 'ref', sessionRef)}
            title={sessionRef}
            style={copyItemStyle(copied === 'ref')}
            onMouseEnter={(e) => { if (copied !== 'ref') { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; if (copied !== 'ref') e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >{copied === 'ref' ? '✓ Copied' : 'Copy session ID'}</button>
          {getConversationText && (
            <button
              onClick={(e) => copy(e, 'conv', getConversationText())}
              style={copyItemStyle(copied === 'conv')}
              onMouseEnter={(e) => { if (copied !== 'conv') { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; if (copied !== 'conv') e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >{copied === 'conv' ? '✓ Copied' : 'Copy conversation'}</button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); setAppearanceOpen(true); }}
            style={{
              display: 'block', width: '100%', padding: '8px 14px',
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
              fontSize: 13, textAlign: 'left' as const, cursor: 'pointer', whiteSpace: 'nowrap' as const,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >Icon &amp; color…</button>
          {onClone && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClone(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,175,55,0.1)'; e.currentTarget.style.color = '#d4af37'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Clone</button>
          )}
          {onClear && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClear(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(251,146,60,0.1)'; e.currentTarget.style.color = '#fb923c'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Clear</button>
          )}
          {onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onClose(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Close</button>
          )}
          {onArchive && (
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive(); }}
              style={{
                display: 'block', width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
            >Archive</button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(); }}
            style={{
              display: 'block', width: '100%', padding: '8px 14px',
              background: 'none', border: 'none', color: '#ff6b6b',
              fontSize: 13, textAlign: 'left' as const, cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,107,107,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >Delete</button>
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
