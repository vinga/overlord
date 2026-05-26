import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { OfficeSnapshot, Session, Room, ArchiveEntry, ActivityItem } from '../types';
import { searchFeed, BoldExcerpt, type SearchMatch } from '../lib/search';
import { useJiraMeta } from '../hooks/useJiraMeta';
import styles from './AdvancedSearchPopup.module.css';

interface AdvancedSearchPopupProps {
  snapshot: OfficeSnapshot | null;
  customNames: Record<string, string>;
  onSelectSession: (session: Session, timestamp?: string, query?: string) => void;
  onOpenArchive: (entry: ArchiveEntry, timestamp?: string, query?: string) => void;
  onClose: () => void;
}

interface ArchiveHit {
  item: ActivityItem;
  excerpt: string;
  boldRanges: [number, number][];
}

interface ArchiveSearchResponse {
  entries: Array<{ entry: ArchiveEntry; matches: ArchiveHit[] }>;
  truncated: boolean;
}

const INCLUDE_ARCHIVED_KEY = 'overlord:searchIncludeArchived';

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
  onOpenArchive,
  onClose,
}: AdvancedSearchPopupProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [includeArchived, setIncludeArchived] = useState<boolean>(() => {
    try { return localStorage.getItem(INCLUDE_ARCHIVED_KEY) === '1'; } catch { return false; }
  });
  const [archiveResults, setArchiveResults] = useState<ArchiveSearchResponse | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const jiraMeta = useJiraMeta();

  useEffect(() => {
    try { localStorage.setItem(INCLUDE_ARCHIVED_KEY, includeArchived ? '1' : '0'); } catch { /* ignore */ }
  }, [includeArchived]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 20);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => {
    const q = query.trim();
    if (!includeArchived || q.length < 2) {
      setArchiveResults(null);
      setArchiveLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setArchiveLoading(true);
      try {
        const res = await fetch(`/api/archive/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as ArchiveSearchResponse;
        setArchiveResults(body);
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') {
          setArchiveResults({ entries: [], truncated: false });
        }
      } finally {
        setArchiveLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, includeArchived]);

  const results = useMemo<RoomResult[]>(() => {
    const q = query.trim();
    if (!q || !snapshot) return [];

    const out: RoomResult[] = [];
    for (const room of snapshot.rooms) {
      const sessionResults: SessionResult[] = [];
      for (const session of room.sessions) {
        const jiraItems: ActivityItem[] = (session.jiraKeys ?? []).map(k => {
          const title = jiraMeta[k]?.title;
          return {
            kind: 'tool',
            toolName: 'JIRA',
            content: title ? `${k} — ${title}` : k,
          };
        });
        const matches = searchFeed([...jiraItems, ...(session.activityFeed ?? [])], q);
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
  }, [query, snapshot, customNames, jiraMeta]);

  const qTrimmed = query.trim();

  return (
    <div className={styles.panel} role="dialog" aria-label="Advanced search">
      <div className={styles.header}>
        <h2 className={styles.title}>Advanced Search</h2>
        <div className={styles.menuWrap} ref={menuWrapRef}>
          <button
            className={`${styles.iconBtn} ${includeArchived ? styles.iconBtn_active : ''}`}
            onClick={() => setMenuOpen(v => !v)}
            title="Search options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          {menuOpen && (
            <div className={styles.menu} role="menu">
              <label className={styles.menuItem} role="menuitemcheckbox" aria-checked={includeArchived}>
                <span className={styles.menuCheck}>{includeArchived ? '✓' : ''}</span>
                <span>Include archived sessions</span>
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={e => setIncludeArchived(e.target.checked)}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          )}
        </div>
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

        {includeArchived && qTrimmed.length >= 2 && (
          <div className={styles.roomGroup}>
            <div className={`${styles.roomHeader} ${styles.roomHeader_archive}`}>
              <span>Archive</span>
              {archiveLoading && <span className={styles.archiveStatus}>searching…</span>}
              {!archiveLoading && archiveResults && (
                <span className={styles.roomCount}>
                  · {archiveResults.entries.reduce((n, e) => n + e.matches.length, 0)} match
                  {archiveResults.entries.reduce((n, e) => n + e.matches.length, 0) === 1 ? '' : 'es'}
                  {archiveResults.truncated ? ' · showing first 300' : ''}
                </span>
              )}
            </div>
            {!archiveLoading && archiveResults && archiveResults.entries.length === 0 && (
              <div className={styles.empty}>No archived hits.</div>
            )}
            {archiveResults?.entries.map(({ entry, matches }) => {
              const key = `archive::${entry.sessionId}`;
              const isExpanded = expanded.has(key);
              const visibleMatches = isExpanded ? matches : matches.slice(0, 3);
              const hasMore = matches.length > 3;
              return (
                <div key={key} className={styles.sessionGroup}>
                  <div
                    className={styles.sessionHeader}
                    onClick={() => { onOpenArchive(entry, undefined, qTrimmed); onClose(); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { onOpenArchive(entry, undefined, qTrimmed); onClose(); } }}
                  >
                    <span className={styles.archiveBadge}>ARCH</span>
                    <span className={styles.sessionName}>{entry.name || entry.sessionId.slice(0, 8)}</span>
                    <span className={styles.sessionParent}>{relativeTime(entry.archivedAt)}</span>
                    <span className={styles.sessionBadge}>{matches.length}</span>
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
                        onClick={() => { onOpenArchive(entry, match.item.timestamp, qTrimmed); onClose(); }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { onOpenArchive(entry, match.item.timestamp, qTrimmed); onClose(); } }}
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
                      onClick={() => setExpanded(prev => new Set([...prev, key]))}
                    >
                      {matches.length - 3} more match{matches.length - 3 === 1 ? '' : 'es'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
