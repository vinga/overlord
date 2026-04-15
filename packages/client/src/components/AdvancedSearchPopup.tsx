import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { OfficeSnapshot, Session, Room } from '../types';
import { searchFeed, BoldExcerpt, type SearchMatch } from '../lib/search';
import styles from './AdvancedSearchPopup.module.css';

interface AdvancedSearchPopupProps {
  snapshot: OfficeSnapshot | null;
  customNames: Record<string, string>;
  onSelectSession: (session: Session, timestamp?: string, query?: string) => void;
  onClose: () => void;
}

interface SessionResult {
  key: string;
  session: Session;
  displayName: string;
  parentName?: string;
  isSubagent: boolean;
  state: string;
  matches: SearchMatch[];
}

interface RoomResult {
  room: Room;
  sessionResults: SessionResult[];
  totalMatches: number;
}

const STATE_COLOR: Record<string, string> = {
  working: '#a78bfa',
  thinking: '#a78bfa',
  waiting: '#f59e0b',
  idle: '#374151',
};

function getDisplayName(session: Session, customNames: Record<string, string>): string {
  return customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function AdvancedSearchPopup({
  snapshot,
  customNames,
  onSelectSession,
  onClose,
}: AdvancedSearchPopupProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 20);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const results = useMemo<RoomResult[]>(() => {
    const q = query.trim();
    if (!q || !snapshot) return [];

    const out: RoomResult[] = [];
    for (const room of snapshot.rooms) {
      const sessionResults: SessionResult[] = [];
      for (const session of room.sessions) {
        const matches = searchFeed(session.activityFeed ?? [], q);
        if (matches.length > 0) {
          sessionResults.push({
            key: session.sessionId,
            session,
            displayName: getDisplayName(session, customNames),
            isSubagent: false,
            state: session.state,
            matches,
          });
        }
        for (const sub of session.subagents ?? []) {
          const subMatches = searchFeed(sub.activityFeed ?? [], q);
          if (subMatches.length > 0) {
            sessionResults.push({
              key: `${session.sessionId}::${sub.agentId}`,
              session,
              displayName: [sub.agentType, sub.description].filter(Boolean).join(' · ').slice(0, 45),
              parentName: getDisplayName(session, customNames),
              isSubagent: true,
              state: sub.state,
              matches: subMatches,
            });
          }
        }
      }
      if (sessionResults.length > 0) {
        const totalMatches = sessionResults.reduce((acc, s) => acc + s.matches.length, 0);
        out.push({ room, sessionResults, totalMatches });
      }
    }
    return out.sort((a, b) => b.totalMatches - a.totalMatches);
  }, [query, snapshot, customNames]);

  const qTrimmed = query.trim();

  return (
    <div className={styles.panel} role="dialog" aria-label="Advanced search">
      <div className={styles.header}>
        <h2 className={styles.title}>Advanced Search</h2>
        <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">✕</button>
      </div>

      <div className={styles.inputWrap}>
        <svg className={styles.inputIcon} viewBox="0 0 16 16" fill="none">
          <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="Search across all rooms…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button
            className={styles.inputClear}
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            title="Clear"
          >✕</button>
        )}
      </div>

      <div className={styles.results}>
        {!qTrimmed && (
          <div className={styles.empty}>Type to search across all rooms, sessions and subagents.</div>
        )}
        {qTrimmed && results.length === 0 && (
          <div className={styles.empty}>No results for &laquo;{qTrimmed}&raquo;</div>
        )}
        {results.map(roomResult => (
          <div key={roomResult.room.id} className={styles.roomGroup}>
            <div className={styles.roomHeader}>
              <span>{roomResult.room.name}</span>
              <span className={styles.roomCount}>· {roomResult.totalMatches} match{roomResult.totalMatches === 1 ? '' : 'es'}</span>
            </div>
            {roomResult.sessionResults.map(sr => {
              const isExpanded = expanded.has(sr.key);
              const visibleMatches = isExpanded ? sr.matches : sr.matches.slice(0, 3);
              const hasMore = sr.matches.length > 3;
              const dotColor = STATE_COLOR[sr.state] ?? '#6b7280';
              return (
                <div key={sr.key} className={styles.sessionGroup}>
                  <div
                    className={styles.sessionHeader}
                    onClick={() => onSelectSession(sr.session, undefined, qTrimmed)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelectSession(sr.session, undefined, qTrimmed); }}
                  >
                    <span className={styles.sessionDot} style={{ color: dotColor }}>●</span>
                    <span className={styles.sessionName}>{sr.displayName}</span>
                    {sr.isSubagent && sr.parentName && (
                      <span className={styles.sessionParent}>← {sr.parentName}</span>
                    )}
                    <span className={styles.sessionBadge}>{sr.matches.length}</span>
                  </div>
                  {visibleMatches.map((match, i) => {
                    const role = match.item.role ?? match.item.kind;
                    const roleLabel = match.item.kind === 'tool'
                      ? (match.item.toolName ?? 'tool')
                      : role;
                    return (
                      <div
                        key={i}
                        className={styles.fragment}
                        onClick={() => onSelectSession(sr.session, match.item.timestamp, qTrimmed)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelectSession(sr.session, match.item.timestamp, qTrimmed); }}
                      >
                        <span className={`${styles.fragmentRole} ${styles[`fragmentRole_${role}`] ?? ''}`}>
                          {roleLabel}
                        </span>
                        <span className={styles.fragmentText}>
                          <BoldExcerpt text={match.excerpt} ranges={match.boldRanges} />
                        </span>
                        {match.item.timestamp && (
                          <span className={styles.fragmentTime}>{relativeTime(match.item.timestamp)}</span>
                        )}
                      </div>
                    );
                  })}
                  {hasMore && !isExpanded && (
                    <button
                      className={styles.showMore}
                      onClick={() => setExpanded(prev => new Set([...prev, sr.key]))}
                    >
                      {sr.matches.length - 3} more match{sr.matches.length - 3 === 1 ? '' : 'es'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
