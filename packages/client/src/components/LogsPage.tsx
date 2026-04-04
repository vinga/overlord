import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { LogEntry, LogEventType } from '../types';
import styles from './LogsPage.module.css';

interface LogsPageProps {
  onBack: () => void;
}

const MAX_ENTRIES = 500;

const EVENT_BADGE_STYLES: Record<LogEventType, { bg: string; color: string }> = {
  'session:created':  { bg: '#22c55e', color: '#000' },
  'session:removed':  { bg: '#ef4444', color: '#fff' },
  'session:replaced': { bg: '#f59e0b', color: '#000' },
  'session:state':    { bg: '#3b82f6', color: '#fff' },
  'session:resumed':  { bg: '#a855f7', color: '#fff' },
  'session:killed':   { bg: '#ef4444', color: '#fff' },
  'pty:started':      { bg: '#06b6d4', color: '#000' },
  'clear:detected':   { bg: '#f59e0b', color: '#000' },
  'info':             { bg: '#374151', color: '#9ca3af' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `[${hh}:${mm}:${ss}]`;
  } catch {
    return '[--:--:--]';
  }
}

export function LogsPage({ onBack }: LogsPageProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollingRef = useRef(false);

  // Keep autoScrollRef in sync
  autoScrollRef.current = autoScroll;

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Auto-scroll when entries change
  useEffect(() => {
    if (autoScrollRef.current) {
      scrollToBottom();
    }
  }, [entries, scrollToBottom]);

  // Scroll event handler to detect manual scroll up
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distFromBottom < 40;
    if (!isAtBottom && autoScrollRef.current) {
      setAutoScroll(false);
    } else if (isAtBottom && !autoScrollRef.current) {
      setAutoScroll(true);
    }
  }, []);

  const resumeAutoScroll = useCallback(() => {
    setAutoScroll(true);
    scrollToBottom();
  }, [scrollToBottom]);

  // WebSocket connection
  useEffect(() => {
    mountedRef.current = true;

    function connect() {
      if (!mountedRef.current) return;

      const ws = new WebSocket('ws://localhost:3000');
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) setConnected(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data as string) as { type?: string };

          if (data.type === 'log:history') {
            const msg = data as { type: string; entries: LogEntry[] };
            setEntries(msg.entries.slice(-MAX_ENTRIES));
          } else if (data.type === 'log:entry') {
            const msg = data as { type: string; entry: LogEntry };
            setEntries(prev => {
              const next = [...prev, msg.entry];
              return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
            });
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 500);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Event Log</span>
          <span className={styles.connectionDot} data-connected={connected} title={connected ? 'Connected' : 'Disconnected'} />
        </div>

        <div className={styles.headerCenter}>
          <button
            className={styles.scrollBadge}
            data-live={autoScroll}
            onClick={autoScroll ? undefined : resumeAutoScroll}
            title={autoScroll ? 'Auto-scrolling to latest events' : 'Click to resume auto-scroll'}
          >
            {autoScroll ? '↓ live' : '⏸ paused'}
          </button>
        </div>

        <div className={styles.headerRight}>
          <span className={styles.entryCount}>{entries.length} events</span>
          <button className={styles.backButton} onClick={onBack}>
            ← Office
          </button>
        </div>
      </header>

      <div
        className={styles.logContainer}
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {entries.length === 0 ? (
          <div className={styles.empty}>Waiting for events…</div>
        ) : (
          entries.map(entry => {
            const badge = EVENT_BADGE_STYLES[entry.event] ?? { bg: '#374151', color: '#9ca3af' };
            return (
              <div key={entry.id} className={styles.row}>
                <span className={styles.timestamp}>{formatTime(entry.timestamp)}</span>
                <span
                  className={styles.badge}
                  style={{ backgroundColor: badge.bg, color: badge.color }}
                >
                  {entry.event}
                </span>
                {entry.sessionName && (
                  <span className={styles.sessionName} title={entry.sessionName}>
                    {entry.sessionName}
                  </span>
                )}
                {entry.sessionId && (
                  <span className={styles.sessionId}>{entry.sessionId.slice(0, 8)}</span>
                )}
                {entry.detail && (
                  <span className={styles.detail}>{entry.detail}</span>
                )}
                {entry.extra && (
                  <span className={styles.extra} title={entry.extra}>{entry.extra}</span>
                )}
              </div>
            );
          })
        )}
        <div ref={sentinelRef} className={styles.sentinel} />
      </div>
    </div>
  );
}
