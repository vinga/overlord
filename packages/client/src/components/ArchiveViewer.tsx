import React, { useEffect, useState } from 'react';
import type { ActivityItem } from '../types';

interface ArchiveTranscriptResponse {
  sessionId: string;
  name: string;
  archivedAt: string;
  cwd: string;
  activityFeed: ActivityItem[];
  lastMessage?: string;
  lastActivity?: string;
  model?: string;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  width: 'min(640px, 100vw)',
  height: '100vh',
  background: '#14141c',
  borderLeft: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '-12px 0 48px rgba(0,0,0,0.5)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'Inter, system-ui, sans-serif',
  color: '#e5e7eb',
};

const HEADER_STYLE: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const BODY_STYLE: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '14px 18px',
  fontSize: 13,
  lineHeight: 1.55,
};

const CLOSE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: 'rgba(255,255,255,0.7)',
  width: 28,
  height: 28,
  cursor: 'pointer',
  fontSize: 14,
};

const BADGE: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#9ca3af',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  padding: '2px 6px',
  borderRadius: 4,
};

const ROW_STYLE = (role?: string): React.CSSProperties => ({
  padding: '10px 12px',
  borderRadius: 8,
  background: role === 'user' ? 'rgba(59,130,246,0.07)' : 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.05)',
  marginBottom: 8,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
});

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#9ca3af',
  marginBottom: 4,
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function ArchiveViewer({ sessionId, onClose }: Props) {
  const [data, setData] = useState<ArchiveTranscriptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetch(`/api/archive/${sessionId}/transcript`)
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error ?? `HTTP ${r.status}`))))
      .then(json => { if (active) setData(json as ArchiveTranscriptResponse); })
      .catch(err => { if (active) setError(err.message || 'Failed to load'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={PANEL_STYLE} role="dialog" aria-label="Archived session">
      <div style={HEADER_STYLE}>
        <span style={BADGE}>Archived</span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data?.name ?? '…'}
          </strong>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {data?.archivedAt ? `archived ${formatDate(data.archivedAt)}` : ''}
          </span>
        </div>
        <button style={CLOSE_STYLE} onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div style={BODY_STYLE}>
        {loading && <div style={{ color: '#9ca3af' }}>Loading transcript…</div>}
        {error && <div style={{ color: '#ef4444' }}>Error: {error}</div>}
        {data && data.activityFeed.length === 0 && (
          <div style={{ color: '#9ca3af' }}>No recorded activity.</div>
        )}
        {data && data.activityFeed.map((item, idx) => {
          if (item.kind === 'message') {
            return (
              <div key={idx} style={ROW_STYLE(item.role)}>
                <div style={LABEL_STYLE}>{item.role ?? 'message'}{item.timestamp ? ` · ${formatDate(item.timestamp)}` : ''}</div>
                {item.content}
              </div>
            );
          }
          if (item.kind === 'tool') {
            return (
              <div key={idx} style={ROW_STYLE()}>
                <div style={LABEL_STYLE}>tool{item.toolName ? ` · ${item.toolName}` : ''}{item.durationMs ? ` · ${item.durationMs}ms` : ''}</div>
                <div style={{ color: item.isError ? '#ef4444' : 'inherit' }}>{item.content}</div>
              </div>
            );
          }
          if (item.kind === 'thinking') {
            return (
              <div key={idx} style={{ ...ROW_STYLE(), opacity: 0.7 }}>
                <div style={LABEL_STYLE}>thinking</div>
                {item.isRedacted ? '[redacted]' : item.content}
              </div>
            );
          }
          if (item.kind === 'compact') {
            return (
              <div key={idx} style={{ ...ROW_STYLE(), borderStyle: 'dashed', textAlign: 'center', color: '#9ca3af' }}>
                — context compacted ({item.compactMeta?.trigger ?? 'auto'}) —
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
