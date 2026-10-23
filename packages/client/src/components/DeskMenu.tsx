import React, { useState } from 'react';
import type { Session } from '../types';
import { ColorPicker } from './ColorPicker';
import { putSessionColor, putSessionIcon } from '../lib/sessionAppearance';

/** Session burger menu — shared by the desk card (Room) and the detail panel header. */
export function DeskMenu({ onDelete, onClone, onClear, onArchive, onClose, sessionRef, session, anchorStyle, buttonSize = 22 }: {
  onDelete: () => void; onClone?: () => void; onClear?: () => void; onArchive?: () => void; onClose?: () => void;
  sessionRef: string; session: Session;
  /** Wrapper position; defaults to the desk card's top-right corner. */
  anchorStyle?: React.CSSProperties;
  buttonSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const burgerRef = React.useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  React.useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const handleCopyRef = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(sessionRef);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => { setCopied(false); setOpen(false); }, 900);
  };

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
      {open && (
        <div style={{
          position: 'absolute', top: buttonSize + 4, right: 0, background: '#1e1e2e',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 100, minWidth: 140,
        }}>
          <button
            onClick={handleCopyRef}
            title={sessionRef}
            style={{
              display: 'block', width: '100%', padding: '8px 14px',
              background: 'none', border: 'none', color: copied ? '#22c55e' : 'rgba(255,255,255,0.7)',
              fontSize: 13, textAlign: 'left' as const, cursor: 'pointer', whiteSpace: 'nowrap' as const,
            }}
            onMouseEnter={(e) => { if (!copied) { e.currentTarget.style.background = 'rgba(148,163,184,0.15)'; e.currentTarget.style.color = '#cbd5e1'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; if (!copied) e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
          >{copied ? '✓ Copied' : 'Copy session ID'}</button>
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
        </div>
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
