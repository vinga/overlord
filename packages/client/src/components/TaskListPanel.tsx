import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { Room, Session, Task, ActivityItem } from '../types';
import styles from './TaskListPanel.module.css';

type Tab = 'agents' | 'tasks' | 'search' | 'skills';
type Filter = 'done' | 'awaiting';

// ── Search helpers ──────────────────────────────────────────────────────────

interface SearchMatch {
  item: ActivityItem;
  excerpt: string;        // ~120 char excerpt with match bolded (as JSX fragments)
  boldRanges: [number, number][]; // [start, end] in excerpt
}

interface AgentSearchResult {
  sessionId: string;
  displayName: string;
  state: string;
  sessionType?: string;
  isSubagent: boolean;
  parentName?: string;
  matches: SearchMatch[];
  onSelect: (timestamp?: string) => void;
}

function buildCorpus(item: ActivityItem): string {
  if (item.kind === 'thinking' && item.isRedacted) return '';
  const parts: string[] = [item.content];
  if (item.inputJson) parts.push(item.inputJson);
  return parts.join(' ');
}

function makeExcerpt(corpus: string, query: string, windowSize = 120): { text: string; start: number; end: number } {
  const lower = corpus.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return { text: corpus.slice(0, windowSize), start: -1, end: -1 };
  const half = Math.floor(windowSize / 2);
  const from = Math.max(0, idx - half + Math.floor(query.length / 2));
  const to = Math.min(corpus.length, from + windowSize);
  const adjusted = Math.max(0, to - windowSize);
  const text = (adjusted > 0 ? '…' : '') + corpus.slice(adjusted, to) + (to < corpus.length ? '…' : '');
  const matchInExcerpt = idx - adjusted + (adjusted > 0 ? 1 : 0); // offset by ellipsis char
  return { text, start: matchInExcerpt, end: matchInExcerpt + query.length };
}

function searchFeed(feed: ActivityItem[], query: string): SearchMatch[] {
  const q = query.toLowerCase();
  return feed
    .filter(item => buildCorpus(item).toLowerCase().includes(q))
    .map(item => {
      const corpus = buildCorpus(item);
      const { text, start, end } = makeExcerpt(corpus, query);
      return { item, excerpt: text, boldRanges: start >= 0 ? [[start, end] as [number, number]] : [] };
    });
}

function BoldExcerpt({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(<strong key={s}>{text.slice(s, e)}</strong>);
    cursor = e;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

interface TaskListPanelProps {
  room: Room;
  customNames: Record<string, string>;
  onSelectSession: (session: Session, timestamp?: string) => void;
  onClose: () => void;
  panelWidth: number;
  onPanelWidthChange: (w: number) => void;
}

function getSessionDisplayName(session: Session, customNames: Record<string, string>): string {
  return customNames[session.sessionId] ?? session.proposedName ?? session.sessionId.slice(0, 8);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const STATE_COLOR: Record<string, string> = {
  working: '#a78bfa',
  thinking: '#a78bfa',
  waiting: '#f59e0b',
  idle: '#374151',
};

const STATE_ICON: Record<string, string> = {
  working: '⚡',
  thinking: '◌',
  waiting: '…',
  idle: '○',
};

interface SkillItem { name: string; description: string; content: string; }
interface SkillsData { skills: SkillItem[]; agents: SkillItem[]; }

export function TaskListPanel({ room, customNames, onSelectSession, onClose, panelWidth, onPanelWidthChange }: TaskListPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [filters, setFilters] = useState<Set<Filter>>(new Set(['done', 'awaiting']));
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [skillsData, setSkillsData] = useState<SkillsData | null>(null);
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isResizingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (activeTab === 'search') {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'skills') return;
    fetch(`/api/skills-agents?cwd=${encodeURIComponent(room.cwd)}`)
      .then(r => r.json())
      .then(data => setSkillsData(data))
      .catch(() => setSkillsData({ skills: [], agents: [] }));
  }, [activeTab, room.cwd]);

  function toggleFilter(f: Filter) {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidth;
    function onMove(ev: MouseEvent) {
      const delta = startX - ev.clientX;
      onPanelWidthChange(Math.max(320, Math.min(900, startWidth + delta)));
    }
    function onUp() {
      isResizingRef.current = false;
      setIsResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const roomSessions = room.sessions;
  const allSessions = roomSessions.map(s => ({ session: s }));

  // ── Agents tab data ──────────────────────────────────────────────────────
  const agentRows = allSessions
    .filter(({ session }) => session.state !== 'closed')
    .sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime());

  // ── Tasks tab data ───────────────────────────────────────────────────────
  // "Done" = completionSummaries entries
  const doneTasks = filters.has('done')
    ? allSessions.flatMap(({ session }) =>
        (session.completionSummaries ?? []).map((task: Task) => ({
          session,
          task,
          text: task.title ?? task.summary ?? '',
          completedAt: task.completedAt ?? task.createdAt,
          kind: 'done' as const,
        }))
      ).sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()).slice(0, 50)
    : [];

  // "Awaiting" = sessions in waiting state that are NOT done
  const awaitingRows = filters.has('awaiting')
    ? allSessions
        .filter(({ session }) =>
          session.state === 'waiting' && session.completionHint !== 'done' && !session.needsPermission
        )
        .sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime())
    : [];

  // "Needs approval" always shown in tasks tab
  const approvalRows = allSessions.filter(({ session }) => session.needsPermission === true);

  const noTasksVisible = doneTasks.length === 0 && awaitingRows.length === 0 && approvalRows.length === 0;

  // ── Search results ──────────────────────────────────────────────────────
  const searchResults = useMemo<AgentSearchResult[]>(() => {
    const q = searchQuery.trim();
    if (!q) return [];

    // Collect all feed items across the room (cap at 2000 most recent by timestamp)
    const results: AgentSearchResult[] = [];

    for (const session of room.sessions) {
      const feed = session.activityFeed ?? [];
      const matches = searchFeed(feed, q);
      if (matches.length > 0) {
        results.push({
          sessionId: session.sessionId,
          displayName: getSessionDisplayName(session, customNames),
          state: session.state,
          sessionType: session.sessionType,
          isSubagent: false,
          matches,
          onSelect: (ts?: string) => onSelectSession(session, ts),
        });
      }

      for (const sub of session.subagents ?? []) {
        const subFeed = sub.activityFeed ?? [];
        const subMatches = searchFeed(subFeed, q);
        if (subMatches.length > 0) {
          results.push({
            sessionId: `${session.sessionId}::${sub.agentId}`,
            displayName: [sub.agentType, sub.description].filter(Boolean).join(' · ').slice(0, 45),
            state: sub.state,
            isSubagent: true,
            parentName: getSessionDisplayName(session, customNames),
            matches: subMatches,
            onSelect: (ts?: string) => onSelectSession(session, ts),
          });
        }
      }
    }

    // Sort by match count descending
    return results.sort((a, b) => b.matches.length - a.matches.length);
  }, [searchQuery, room.sessions, customNames, onSelectSession]);

  function handleSelect(session: Session) {
    onSelectSession(session);
  }

  return (
    <div className={`${styles.panel} ${isResizing ? styles.resizing : ''}`} style={{ width: panelWidth }}>
      <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />

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
          </div>
        </div>
        <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
      </div>

      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${activeTab === 'agents' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          Agents
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'tasks' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('tasks')}
        >
          Tasks
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'search' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('search')}
        >
          Search
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'skills' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('skills')}
        >
          Skills
        </button>
      </div>

      {/* Tasks tab: filter chips */}
      {activeTab === 'tasks' && (
        <div className={styles.filterBar}>
          <button
            className={`${styles.filterChip} ${filters.has('done') ? styles.filterChipDone : ''}`}
            onClick={() => toggleFilter('done')}
          >
            ✓ Done
          </button>
          <button
            className={`${styles.filterChip} ${filters.has('awaiting') ? styles.filterChipAwaiting : ''}`}
            onClick={() => toggleFilter('awaiting')}
          >
            … Awaiting
          </button>
        </div>
      )}

      {/* Content */}
      <div className={styles.content}>

        {/* ── AGENTS TAB ── */}
        {activeTab === 'agents' && (
          agentRows.length === 0
            ? <div className={styles.empty}>No active agents</div>
            : agentRows.map(({ session }) => {
                const isDone = session.state === 'waiting' && session.completionHint === 'done';
                const dotColor = isDone ? '#22c55e' : STATE_COLOR[session.state] ?? '#6b7280';
                const icon = isDone ? '✓' : STATE_ICON[session.state] ?? '○';
                const text = session.lastMessage?.slice(0, 120) ?? `${session.state}…`;
                const activeSubagents = session.subagents.filter(s => s.state === 'working' || s.state === 'thinking');
                return (
                  <div
                    key={session.sessionId}
                    className={styles.row}
                    onClick={() => handleSelect(session)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleSelect(session); }}
                  >
                    <span className={styles.rowIcon} style={{ color: dotColor }}>{icon}</span>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>
                        {getSessionDisplayName(session, customNames)}
                        {activeSubagents.length > 0 && (
                          <span className={styles.badge} style={{ color: '#a78bfa' }}>↗{activeSubagents.length}</span>
                        )}
                        {session.needsPermission && (
                          <span className={styles.badge} style={{ color: '#f59e0b' }}>⚠</span>
                        )}
                      </div>
                      <div className={styles.rowText}>{text}</div>
                      <div className={styles.rowMeta}>
                        <span className={styles.metaTime}>{relativeTime(session.lastActivity)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
        )}

        {/* ── TASKS TAB ── */}
        {activeTab === 'tasks' && (
          <>
            {approvalRows.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionLabel}>Needs approval</div>
                {approvalRows.map(({ session }) => (
                  <div key={session.sessionId} className={styles.row} onClick={() => handleSelect(session)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') handleSelect(session); }}>
                    <span className={styles.rowIcon} style={{ color: '#f59e0b' }}>⚠</span>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>{getSessionDisplayName(session, customNames)}</div>
                      <div className={styles.rowMeta}>
                        <span className={styles.metaTime}>{relativeTime(session.lastActivity)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {awaitingRows.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionLabel}>Awaiting your response</div>
                {awaitingRows.map(({ session }) => (
                  <div key={session.sessionId} className={styles.row} onClick={() => handleSelect(session)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') handleSelect(session); }}>
                    <span className={styles.rowIcon} style={{ color: '#f59e0b' }}>…</span>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>{getSessionDisplayName(session, customNames)}</div>
                      {session.lastMessage && <div className={styles.rowText}>{session.lastMessage.slice(0, 120)}</div>}
                      <div className={styles.rowMeta}>
                        <span className={styles.metaTime}>{relativeTime(session.lastActivity)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {doneTasks.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionLabel}>Done</div>
                {doneTasks.map(({ session, task, text, completedAt }, i) => {
                  const isAccepted = task.accepted ?? false;
                  return (
                  <div key={`${session.sessionId}-${i}`} className={`${styles.row} ${styles.rowDone}`} onClick={() => handleSelect(session)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') handleSelect(session); }}>
                    <span className={styles.rowIcon} style={{ color: isAccepted ? '#22c55e' : '#f59e0b' }}>✓</span>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>{text || getSessionDisplayName(session, customNames)}</div>
                      {task.summary && task.title && <div className={styles.rowText}>{task.summary}</div>}
                      <div className={styles.rowMeta}>
                        <span className={styles.metaSession}>{task.sessionName ?? getSessionDisplayName(session, customNames)}</span>
                        <span className={styles.metaDot}>·</span>
                        <span className={styles.metaTime}>{relativeTime(completedAt)}</span>
                        {!isAccepted && (
                          <><span className={styles.metaDot}>·</span><span className={styles.metaReview}>review</span></>
                        )}
                      </div>
                    </div>
                    {!isAccepted && (
                      <button
                        className={styles.rowAcceptBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          fetch(`/api/sessions/${session.sessionId}/accept-task`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ completedAt: task.completedAt }),
                          }).catch(console.error);
                        }}
                      >
                        Accept
                      </button>
                    )}
                  </div>
                  );
                })}
              </section>
            )}

            {noTasksVisible && (
              <div className={styles.empty}>
                {filters.size === 0 ? 'Select a filter above' : 'No tasks to show'}
              </div>
            )}
          </>
        )}

        {/* ── SEARCH TAB ── */}
        {activeTab === 'search' && (
          <div className={styles.searchPane}>
            <div className={styles.searchInputWrap}>
              <svg className={styles.searchIcon} viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <input
                ref={searchInputRef}
                className={styles.searchInput}
                type="text"
                placeholder="Search conversations…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className={styles.searchClear}
                  onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
                  title="Clear"
                >✕</button>
              )}
            </div>

            {!searchQuery.trim() && (
              <div className={styles.searchEmpty}>Type to search across sessions in this room.</div>
            )}

            {searchQuery.trim() && searchResults.length === 0 && (
              <div className={styles.searchEmpty}>No results for &laquo;{searchQuery.trim()}&raquo;</div>
            )}

            {searchResults.map(result => {
              const isExpanded = expandedAgents.has(result.sessionId);
              const visibleMatches = isExpanded ? result.matches : result.matches.slice(0, 3);
              const hasMore = result.matches.length > 3;
              const dotColor = STATE_COLOR[result.state] ?? '#6b7280';
              const icon = STATE_ICON[result.state] ?? '○';

              return (
                <div
                  key={result.sessionId}
                  className={`${styles.searchGroup} ${result.isSubagent ? styles.searchGroupSub : ''}`}
                >
                  {/* Agent header */}
                  <div
                    className={styles.searchGroupHeader}
                    onClick={() => result.onSelect()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') result.onSelect(); }}
                  >
                    <span className={styles.searchDot} style={{ color: dotColor }}>{icon}</span>
                    {/* Agent icon */}
                    <svg className={styles.searchAgentIcon} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="2" y="6" width="12" height="8" rx="2" stroke="currentColor" strokeWidth="1.3"/>
                      <circle cx="5.5" cy="10" r="1" fill="currentColor"/>
                      <circle cx="10.5" cy="10" r="1" fill="currentColor"/>
                      <path d="M6 3.5C6 2.67 6.67 2 7.5 2h1C9.33 2 10 2.67 10 3.5V6H6V3.5z" stroke="currentColor" strokeWidth="1.3"/>
                      <path d="M8 2V1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                    <span className={styles.searchAgentName}>{result.displayName}</span>
                    {result.isSubagent && result.parentName && (
                      <span className={styles.searchParentBadge}>{result.parentName}</span>
                    )}
                    {result.sessionType && result.sessionType !== 'plain' && (
                      <span className={styles.searchTypeBadge}>{result.sessionType}</span>
                    )}
                    <span className={styles.searchMatchCount}>{result.matches.length}</span>
                  </div>

                  {/* Match fragments */}
                  {visibleMatches.map((match, i) => {
                    const roleLabel = match.item.kind === 'tool'
                      ? (match.item.toolName ?? 'tool')
                      : (match.item.role ?? match.item.kind);
                    return (
                      <div
                        key={i}
                        className={styles.searchFragment}
                        onClick={() => result.onSelect(match.item.timestamp)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') result.onSelect(match.item.timestamp); }}
                      >
                        <span className={`${styles.searchRole} ${styles[`searchRole_${match.item.role ?? match.item.kind}`]}`}>
                          {roleLabel}
                        </span>
                        <span className={styles.searchFragmentText}>
                          <BoldExcerpt text={match.excerpt} ranges={match.boldRanges} />
                        </span>
                        {match.item.timestamp && (
                          <span className={styles.searchFragmentTime}>
                            {relativeTime(match.item.timestamp)}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {hasMore && !isExpanded && (
                    <button
                      className={styles.searchShowMore}
                      onClick={e => { e.stopPropagation(); setExpandedAgents(prev => new Set([...prev, result.sessionId])); }}
                    >
                      {result.matches.length - 3} more match{result.matches.length - 3 > 1 ? 'es' : ''}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* ── SKILLS TAB ── */}
        {activeTab === 'skills' && (
          <div className={styles.skillsPane}>
            {!skillsData && <div className={styles.skillsLoading}>Loading…</div>}
            {skillsData && skillsData.skills.length === 0 && skillsData.agents.length === 0 && (
              <div className={styles.empty}>No skills or agents found in <code>.claude/skills</code> or <code>.claude/agents</code></div>
            )}
            {skillsData && skillsData.skills.length > 0 && (
              <section className={styles.skillSection}>
                <div className={styles.skillSectionTitle}>Skills</div>
                {skillsData.skills.map(skill => {
                  const isExpanded = expandedSkills.has(skill.name);
                  return (
                    <div
                      key={skill.name}
                      className={`${styles.skillCard} ${isExpanded ? styles.skillCardExpanded : ''}`}
                    >
                      <div
                        className={styles.skillCardHeader}
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedSkills(prev => {
                          const next = new Set(prev);
                          if (next.has(skill.name)) next.delete(skill.name); else next.add(skill.name);
                          return next;
                        })}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            setExpandedSkills(prev => {
                              const next = new Set(prev);
                              if (next.has(skill.name)) next.delete(skill.name); else next.add(skill.name);
                              return next;
                            });
                          }
                        }}
                      >
                        <span className={styles.skillCardChevron}>{isExpanded ? '▾' : '▸'}</span>
                        <span className={styles.skillCardName}>/{skill.name}</span>
                        <button
                          className={`${styles.skillCardCopy} ${copiedSkill === skill.name ? styles.skillCardCopied : ''}`}
                          title={`Copy /${skill.name}`}
                          onClick={e => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(`/${skill.name}`).catch(() => {});
                            setCopiedSkill(skill.name);
                            setTimeout(() => setCopiedSkill(null), 1500);
                          }}
                        >
                          {copiedSkill === skill.name ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      {!isExpanded && skill.description && (
                        <div className={styles.skillCardDesc}>{skill.description}</div>
                      )}
                      {isExpanded && skill.content && (
                        <pre className={styles.skillCardContent}>{skill.content}</pre>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
            {skillsData && skillsData.agents.length > 0 && (
              <section className={styles.skillSection}>
                <div className={styles.skillSectionTitle}>Agents</div>
                {skillsData.agents.map(agent => {
                  const isExpanded = expandedSkills.has(`agent:${agent.name}`);
                  return (
                    <div
                      key={agent.name}
                      className={`${styles.skillCard} ${isExpanded ? styles.skillCardExpanded : ''}`}
                    >
                      <div
                        className={styles.skillCardHeader}
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedSkills(prev => {
                          const next = new Set(prev);
                          const k = `agent:${agent.name}`;
                          if (next.has(k)) next.delete(k); else next.add(k);
                          return next;
                        })}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            setExpandedSkills(prev => {
                              const next = new Set(prev);
                              const k = `agent:${agent.name}`;
                              if (next.has(k)) next.delete(k); else next.add(k);
                              return next;
                            });
                          }
                        }}
                      >
                        <span className={styles.skillCardChevron}>{isExpanded ? '▾' : '▸'}</span>
                        <span className={styles.skillCardName}>{agent.name}</span>
                      </div>
                      {!isExpanded && agent.description && (
                        <div className={styles.skillCardDesc}>{agent.description}</div>
                      )}
                      {isExpanded && agent.content && (
                        <pre className={styles.skillCardContent}>{agent.content}</pre>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
