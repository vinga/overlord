import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';

interface ArchiveStats {
  sessionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  durationMs: number | null;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  compactCount: number;
  transcriptCount: number;
  totalLines: number;
  model?: string;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

const statsCache = new Map<string, ArchiveStats>();

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function ArchiveStatsTooltip({ sessionId }: { sessionId: string }) {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>(statsCache.has(sessionId) ? 'ready' : 'idle');
  const [stats, setStats] = useState<ArchiveStats | null>(statsCache.get(sessionId) ?? null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const fetched = useRef(statsCache.has(sessionId));

  const ensureFetch = useCallback(() => {
    if (fetched.current) return;
    fetched.current = true;
    setStatus('loading');
    fetch(`/api/archive/${encodeURIComponent(sessionId)}/stats`)
      .then(r => {
        if (!r.ok) throw new Error(`http ${r.status}`);
        return r.json() as Promise<ArchiveStats>;
      })
      .then(s => {
        statsCache.set(sessionId, s);
        setStats(s);
        setStatus('ready');
      })
      .catch(() => {
        fetched.current = false;
        setStatus('error');
      });
  }, [sessionId]);

  return (
    <span
      onMouseEnter={e => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top - 8 });
        setVisible(true);
        ensureFetch();
      }}
      onMouseLeave={e => {
        e.stopPropagation();
        setVisible(false);
      }}
      onClick={e => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', cursor: 'default',
        color: 'rgba(255,255,255,0.28)', flexShrink: 0, marginLeft: 2,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="9" fontFamily="Inter,system-ui,sans-serif" fontWeight="600">i</text>
      </svg>
      {visible && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)',
          background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 8, padding: '10px 12px', width: 280,
          fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, lineHeight: 1.5,
          color: 'rgba(255,255,255,0.85)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 9999, pointerEvents: 'none',
        }}>
          {status === 'loading' && (
            <div style={{ color: 'rgba(255,255,255,0.5)' }}>Loading stats…</div>
          )}
          {status === 'error' && (
            <div style={{ color: 'rgba(255,120,120,0.75)' }}>Stats unavailable</div>
          )}
          {status === 'ready' && stats && (
            <StatsGrid stats={stats} />
          )}
        </div>,
        document.body
      )}
    </span>
  );
}

function StatsGrid({ stats }: { stats: ArchiveStats }) {
  const rows: Array<[string, string]> = [
    ['Started', formatDateTime(stats.startedAt)],
    ['Finished', formatDateTime(stats.finishedAt)],
    ['Duration', formatDuration(stats.durationMs)],
    ['Messages', `U ${stats.userMessageCount} · A ${stats.assistantMessageCount}`],
    ['Tool uses', String(stats.toolUseCount)],
    ['Compactions', String(stats.compactCount)],
    ['Transcripts', String(stats.transcriptCount)],
    ['Total lines', stats.totalLines.toLocaleString()],
  ];
  if (stats.model) rows.push(['Model', stats.model]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 3 }}>
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <div style={{ color: 'rgba(255,255,255,0.5)' }}>{k}</div>
          <div style={{ color: 'rgba(255,255,255,0.92)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
        </React.Fragment>
      ))}
    </div>
  );
}
