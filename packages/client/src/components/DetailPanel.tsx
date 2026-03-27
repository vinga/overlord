import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import type { Session, WorkerState, ActivityItem } from '../types';
import { XtermTerminal } from './XtermTerminal';
import styles from './DetailPanel.module.css';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

interface DetailPanelProps {
  selectedSession: Session | null;
  selectedSubagentId?: string;
  customName?: string;
  onRename: (sessionId: string, name: string) => void;
  onClose: () => void;
  connected: boolean;
  isPtySession: (sessionId: string) => boolean;
  sendInput: (sessionId: string, data: string) => void;
  injectText: (sessionId: string, text: string, extraEnter?: boolean) => void;
  resizePty: (sessionId: string, cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => () => void;
  exitedSessions: Set<string>;
  getError: (sessionId: string) => string | undefined;
  isInDormitory?: (sessionId: string) => boolean;
  onToggleDormitory?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  siblingActiveSessions?: Session[];
  onSelectSession?: (session: Session) => void;
  customNames?: Record<string, string>;
  onResumeSession?: (sessionId: string, cwd: string) => void;
  panelWidth?: number;
  onPanelWidthChange?: (width: number) => void;
}

function getModelContextWindow(model?: string): number {
  if (!model) return 200_000;
  if (model.includes('haiku')) return 200_000;
  if (model.includes('opus')) return 200_000;
  if (model.includes('sonnet')) return 200_000;
  return 200_000; // all current Claude models are 200k
}

function computeDiff(oldStr: string, newStr: string): Array<{ type: 'removed' | 'added' | 'context', text: string }> {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: Array<{ type: 'removed' | 'added' | 'context', text: string }> = [];
  // Simple: show removed lines then added lines (not LCS, but clear enough)
  for (const line of oldLines) result.push({ type: 'removed', text: line });
  for (const line of newLines) result.push({ type: 'added', text: line });
  return result;
}

const STATE_COLORS: Record<WorkerState, string> = {
  working: '#22c55e',   // green — actively running
  thinking: '#a78bfa',  // purple — processing
  waiting: '#f59e0b',   // amber — waiting for user input
  idle: '#374151',      // dark gray — not active
};

function formatDuration(startedAt: number): string {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatStartedAt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(isoTimestamp: string): string {
  try {
    const diffMs = Date.now() - new Date(isoTimestamp).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    return `${diffHour}h ago`;
  } catch {
    return isoTimestamp;
  }
}

function StateBadge({ state }: { state: WorkerState }) {
  return (
    <span
      className={styles.stateBadge}
      style={{ background: STATE_COLORS[state], color: '#1a1a2e' }}
    >
      {state}
    </span>
  );
}

function useTick(intervalMs: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

type FeedSegment =
  | { type: 'message'; item: ActivityItem }
  | { type: 'toolGroup'; items: ActivityItem[] };

function buildSegments(feed: ActivityItem[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  for (const item of feed) {
    if (item.kind === 'tool') {
      const last = segments[segments.length - 1];
      if (last?.type === 'toolGroup') {
        last.items.push(item);
      } else {
        segments.push({ type: 'toolGroup', items: [item] });
      }
    } else {
      segments.push({ type: 'message', item });
    }
  }
  return segments;
}

function parseTaskNotification(content: string): { summary: string; status: string } | null {
  if (!content.trimStart().startsWith('<task-notification>')) return null;
  const summary = content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'Task completed';
  const status = content.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? 'completed';
  return { summary, status };
}

function renderSegments(
  segments: FeedSegment[],
  expandedToolGroups: Set<number>,
  setExpandedToolGroups: React.Dispatch<React.SetStateAction<Set<number>>>,
  roleLabel: (role: string) => string,
  styles: Record<string, string>,
  expandedDiffs: Set<string>,
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Set<string>>>,
  rawSegments: Set<number>,
  setRawSegments: React.Dispatch<React.SetStateAction<Set<number>>>,
): React.ReactNode[] {
  return segments.map((seg, segIdx) => {
    if (seg.type === 'message') {
      const notification = seg.item.role === 'user' ? parseTaskNotification(seg.item.content) : null;
      if (notification) {
        const icon = notification.status === 'completed' ? '✓' : notification.status === 'error' ? '✗' : '●';
        return (
          <div key={segIdx} className={styles.systemNotification}>
            <span className={styles.systemNotificationIcon}>{icon}</span>
            <span className={styles.systemNotificationText}>{notification.summary}</span>
          </div>
        );
      }
      const isRaw = rawSegments.has(segIdx);
      return (
        <div key={segIdx} className={`${styles.transcriptEntry} ${styles[`role_${seg.item.role}`]}`}>
          <div className={styles.transcriptBubble}>
            {seg.item.role === 'assistant' ? (
              <>
                {isRaw ? (
                  <pre className={styles.rawContent}>{seg.item.content}</pre>
                ) : (
                  <div
                    className={styles.markdownContent}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.item.content) }}
                  />
                )}
                <button
                  className={styles.rawToggle}
                  onClick={() => setRawSegments(prev => {
                    const next = new Set(prev);
                    if (next.has(segIdx)) next.delete(segIdx); else next.add(segIdx);
                    return next;
                  })}
                  title={isRaw ? 'Show formatted' : 'Show raw text'}
                >
                  {isRaw ? 'md' : 'raw'}
                </button>
              </>
            ) : (
              <span className={styles.transcriptContent}>{seg.item.content}</span>
            )}
          </div>
        </div>
      );
    }
    // Single-tool group — show inline, no toggle
    if (seg.items.length === 1) {
      const tool = seg.items[0];
      const diffKey = `${segIdx}-0`;
      const hasDiff = tool.toolName === 'Edit' && tool.oldString !== undefined;
      const isDiffExpanded = expandedDiffs.has(diffKey);
      return (
        <div key={segIdx} className={styles.toolEntry}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
            <span className={styles.toolName}>⚡ {tool.toolName}</span>
            {hasDiff && (
              <button
                className={styles.diffToggle}
                onClick={() => setExpandedDiffs(prev => {
                  const next = new Set(prev);
                  if (next.has(diffKey)) next.delete(diffKey); else next.add(diffKey);
                  return next;
                })}
              >
                diff
              </button>
            )}
          </div>
          {tool.content && <span className={styles.toolDesc}>{tool.content}</span>}
          {hasDiff && isDiffExpanded && (
            <div className={styles.diffView}>
              {computeDiff(tool.oldString!, tool.newString ?? '').map((line, li) => (
                <div
                  key={li}
                  className={`${styles.diffLine} ${line.type === 'removed' ? styles.diffRemoved : styles.diffAdded}`}
                >
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    // Multi-tool group — collapsible, expanded only if in the set
    const isExpanded = expandedToolGroups.has(segIdx);
    const toolNames = seg.items.map(t => t.toolName ?? '').filter(Boolean);
    const summary = toolNames.length <= 3
      ? toolNames.join(', ')
      : toolNames.slice(0, 3).join(', ') + ` +${toolNames.length - 3}`;
    return (
      <div key={segIdx} className={styles.toolGroup}>
        <button
          className={styles.toolGroupHeader}
          onClick={() => {
            setExpandedToolGroups(prev => {
              const next = new Set(prev);
              if (next.has(segIdx)) next.delete(segIdx); else next.add(segIdx);
              return next;
            });
          }}
        >
          <span className={styles.toolGroupIcon}>⚡</span>
          <span className={styles.toolGroupSummary}>{summary}</span>
          <span className={styles.toolGroupCount}>{seg.items.length}</span>
          <span className={styles.toolGroupChevron}>{isExpanded ? '▾' : '▸'}</span>
        </button>
        {isExpanded && seg.items.map((tool, ti) => {
          const diffKey = `${segIdx}-${ti}`;
          const hasDiff = tool.toolName === 'Edit' && tool.oldString !== undefined;
          const isDiffExpanded = expandedDiffs.has(diffKey);
          return (
            <div key={ti} className={styles.toolEntry}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <span className={styles.toolName}>⚡ {tool.toolName}</span>
                {hasDiff && (
                  <button
                    className={styles.diffToggle}
                    onClick={() => setExpandedDiffs(prev => {
                      const next = new Set(prev);
                      if (next.has(diffKey)) next.delete(diffKey); else next.add(diffKey);
                      return next;
                    })}
                  >
                    diff
                  </button>
                )}
              </div>
              {tool.content && <span className={styles.toolDesc}>{tool.content}</span>}
              {hasDiff && isDiffExpanded && (
                <div className={styles.diffView}>
                  {computeDiff(tool.oldString!, tool.newString ?? '').map((line, li) => (
                    <div
                      key={li}
                      className={`${styles.diffLine} ${line.type === 'removed' ? styles.diffRemoved : styles.diffAdded}`}
                    >
                      {line.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  });
}

export function DetailPanel({
  selectedSession,
  selectedSubagentId,
  customName,
  onRename,
  onClose,
  connected,
  isPtySession,
  sendInput,
  injectText,
  resizePty,
  registerOutputHandler,
  exitedSessions,
  getError,
  isInDormitory,
  onToggleDormitory,
  onDeleteSession,
  siblingActiveSessions,
  onSelectSession,
  customNames,
  onResumeSession,
  panelWidth: panelWidthProp,
  onPanelWidthChange,
}: DetailPanelProps) {
  const isOpen = selectedSession !== null;

  // Re-render every second to update duration / relative times — only when panel is open
  useTick(selectedSession ? 1000 : null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const [panelWidthLocal, setPanelWidthLocal] = useState<number>(() => {
    const saved = localStorage.getItem('overlord:panelWidth');
    return saved ? Math.max(320, Math.min(900, parseInt(saved, 10))) : 680;
  });
  const panelWidth = panelWidthProp ?? panelWidthLocal;
  function setPanelWidth(next: number) {
    setPanelWidthLocal(next);
    onPanelWidthChange?.(next);
  }
  const dragStartX = useRef<number | null>(null);
  const dragStartWidth = useRef<number>(680);

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;

    function onMouseMove(ev: MouseEvent) {
      if (dragStartX.current === null) return;
      const delta = dragStartX.current - ev.clientX;
      const next = Math.max(320, Math.min(900, dragStartWidth.current + delta));
      setPanelWidth(next);
    }

    function onMouseUp() {
      dragStartX.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('overlord:panelWidth', String(panelWidth));
      onPanelWidthChange?.(panelWidth);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function handleTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    const threshold = 40; // px from bottom counts as "at bottom"
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showIdleSubagents, setShowIdleSubagents] = useState(false);
  const [localSent, setLocalSent] = useState<string[]>([]);
  const [sendInput2, setSendInput2] = useState('');
  const [pastedImage, setPastedImage] = useState<{ path: string; previewUrl: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showSubagentDetails, setShowSubagentDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const [rawSegments, setRawSegments] = useState<Set<number>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const currentDisplayName =
    customName ??
    selectedSession?.proposedName ??
    selectedSession?.slug ??
    (selectedSession?.sessionId.slice(0, 8) ?? '');

  const selectedSubagent = selectedSubagentId
    ? selectedSession?.subagents.find(s => s.agentId === selectedSubagentId)
    : undefined;

  // Auto-scroll when feed changes, only if already at bottom
  useEffect(() => {
    if (isAtBottomRef.current && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [selectedSession?.activityFeed, selectedSubagent?.activityFeed]);

  // Reset scroll to bottom and edit state when selected session/subagent changes
  useEffect(() => {
    isAtBottomRef.current = true;
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
    setIsEditing(false);
    setEditValue('');
    setLocalSent([]);
    setSendInput2('');
    setShowDetails(false);
    setShowSubagentDetails(false);
    setConfirmDelete(false);
    setExpandedToolGroups(new Set());
    setExpandedDiffs(new Set());
    setRawSegments(new Set());
    setPastedImage(null);
    setShowSummary(false);
    setSummary(null);
    setSummaryLoading(false);
    setSummaryError(null);
  }, [selectedSession?.sessionId, selectedSubagentId]);

  const fetchSummary = useCallback((sessionId: string) => {
    setSummary(null);
    setSummaryLoading(true);
    setSummaryError(null);
    fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then(r => r.json() as Promise<{ summary?: string; error?: string }>)
      .then(data => {
        if (data.error) setSummaryError(data.error);
        else setSummary(data.summary ?? null);
      })
      .catch(err => setSummaryError((err as Error).message))
      .finally(() => setSummaryLoading(false));
  }, []);

  useEffect(() => {
    if (!showSummary || !selectedSession) return;
    fetchSummary(selectedSession.sessionId);
  }, [showSummary, selectedSession?.sessionId]);

  function startEdit() {
    setEditValue(currentDisplayName);
    setIsEditing(true);
  }

  function commitEdit() {
    if (selectedSession) {
      onRename(selectedSession.sessionId, editValue);
    }
    setIsEditing(false);
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setIsEditing(false);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const isPty = selectedSession ? isPtySession(selectedSession.sessionId) : false;
  const isExited = selectedSession ? exitedSessions.has(selectedSession.sessionId) : false;

  // Build merged activityFeed: real feed + optimistic locally-sent messages
  const realFeed = selectedSession?.activityFeed ?? [];
  const knownUserContents = new Set(realFeed.filter(i => i.role === 'user').map(i => i.content.slice(0, 200)));
  const mergedFeed = [
    ...realFeed,
    ...localSent
      .filter(t => !knownUserContents.has(t.slice(0, 200)))
      .map(t => ({ kind: 'message' as const, role: 'user' as const, content: t.slice(0, 200) })),
  ];

  return (
    <>
      {/* Panel */}
      <div
        className={`${styles.panel} ${isOpen ? styles.panelOpen : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        style={{ width: panelWidth }}
      >
        <div className={styles.resizeHandle} onMouseDown={onResizeMouseDown} />
        {selectedSession && (
          <>
            {/* Color strip */}
            <div
              className={styles.colorStrip}
              style={{ background: selectedSession.color }}
            />

            {/* Close button */}
            <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">
              &times;
            </button>

            {selectedSubagent ? (
              /* Subagent view */
              <>
                <div className={styles.panelHeader}>
                  <h2 className={styles.sessionName}>{selectedSubagent.description || selectedSubagent.agentType}</h2>
                  <div className={styles.summaryRow}>
                    <StateBadge state={selectedSubagent.state} />
                    <span className={styles.summaryMeta}>{formatRelativeTime(selectedSubagent.lastActivity)}</span>
                    <button
                      className={styles.detailsToggle}
                      onClick={() => setShowSubagentDetails(s => !s)}
                    >
                      {showSubagentDetails ? '▴ less' : '▾ details'}
                    </button>
                  </div>
                  {showSubagentDetails && (
                    <div className={styles.detailsExpanded}>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Agent ID</span>
                        <span className={styles.fieldValue}>{selectedSubagent.agentId.slice(0, 8)}</span>
                      </div>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Type</span>
                        <span className={styles.fieldValue}>{selectedSubagent.agentType}</span>
                      </div>
                      {selectedSubagent.description && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Description</span>
                          <span className={styles.fieldValue}>{selectedSubagent.description}</span>
                        </div>
                      )}
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Last activity</span>
                        <span className={styles.fieldValue}>{formatRelativeTime(selectedSubagent.lastActivity)}</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleTranscriptScroll}>
                  <section className={styles.section}>
                    {selectedSubagent.activityFeed?.length ? (
                      <div className={styles.transcript}>
                        {renderSegments(
                          buildSegments(selectedSubagent.activityFeed),
                          expandedToolGroups,
                          setExpandedToolGroups,
                          (role) => role === 'user' ? 'parent' : 'claude',
                          styles as Record<string, string>,
                          expandedDiffs,
                          setExpandedDiffs,
                          rawSegments,
                          setRawSegments,
                        )}
                      </div>
                    ) : (
                      <div className={styles.messageBox}>No activity recorded yet.</div>
                    )}
                  </section>
                </div>
              </>
            ) : (
              /* Session view */
              <>
                {/* Sticky header */}
                <div className={styles.panelHeader}>
                  <div className={styles.nameRow}>
                    {isEditing ? (
                      <>
                        <input
                          className={styles.nameInput}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={handleEditKeyDown}
                          onBlur={commitEdit}
                          autoFocus
                          maxLength={60}
                        />
                        <button className={`${styles.nameBtn} ${styles.nameBtnVisible}`} onClick={commitEdit} title="Save">✓</button>
                        <button className={`${styles.nameBtn} ${styles.nameBtnVisible}`} onClick={() => setIsEditing(false)} title="Cancel">✕</button>
                      </>
                    ) : confirmDelete ? (
                      <>
                        <span className={styles.deleteConfirmInline}>Remove session?</span>
                        <button className={styles.deleteConfirmBtn} onClick={() => { onDeleteSession!(selectedSession.sessionId); onClose(); }}>Yes</button>
                        <button className={styles.deleteCancelBtn} onClick={() => setConfirmDelete(false)}>No</button>
                      </>
                    ) : (
                      <>
                        <h2 className={styles.sessionName} onDoubleClick={startEdit} style={{ cursor: 'default' }}>{currentDisplayName}</h2>
                        <button className={styles.nameBtn} onClick={startEdit} title="Rename">✎</button>
                        {onDeleteSession && (
                          <button className={styles.deleteIconBtn} onClick={() => setConfirmDelete(true)} title="Delete session">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                            </svg>
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  <div className={styles.summaryRow}>
                    <StateBadge state={selectedSession.state} />
                    <span className={styles.summaryMeta}>{formatRelativeTime(selectedSession.lastActivity)}</span>
                    {selectedSession.model && <span className={styles.summaryMeta}>{selectedSession.model.replace('claude-', '')}</span>}
                    {onToggleDormitory && (
                      <button
                        className={`${styles.dormitoryBtn} ${isInDormitory?.(selectedSession.sessionId) ? styles.dormitoryBtnActive : ''}`}
                        onClick={() => onToggleDormitory(selectedSession.sessionId)}
                        title={isInDormitory?.(selectedSession.sessionId) ? 'Bring back from dormitory' : 'Put to dormitory'}
                      >
                        {isInDormitory?.(selectedSession.sessionId) ? '↑ Bring back' : '↓ Dormitory'}
                      </button>
                    )}
                    <button
                      className={`${styles.summaryToggle} ${showSummary ? styles.summaryToggleActive : ''}`}
                      onClick={() => setShowSummary(s => !s)}
                      title="Toggle high-level summary"
                    >
                      ∑
                    </button>
                    <button className={styles.detailsToggle} onClick={() => setShowDetails(s => !s)}>
                      {showDetails ? '▴ less' : '▾ details'}
                    </button>
                  </div>

                  {showDetails && (
                    <div className={styles.detailsExpanded}>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>ID</span>
                        <span className={styles.fieldValue} title={selectedSession.sessionId}>
                          {selectedSession.sessionId.slice(0, 8)}
                          <span className={styles.compactInline}> · PID {selectedSession.pid}</span>
                        </span>
                      </div>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Workspace</span>
                        <span className={`${styles.fieldValue} ${styles.cwd}`}>{selectedSession.cwd}</span>
                      </div>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Duration</span>
                        <span className={styles.fieldValue}>{formatDuration(selectedSession.startedAt)}</span>
                      </div>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Started</span>
                        <span className={styles.fieldValue}>{formatStartedAt(selectedSession.startedAt)}</span>
                      </div>
                      {selectedSession.ideName && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>IDE</span>
                          <span className={styles.fieldValue}>{selectedSession.ideName}</span>
                        </div>
                      )}
                      {selectedSession.model && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Model</span>
                          <span className={styles.fieldValue}>{selectedSession.model.replace('claude-', '')}</span>
                        </div>
                      )}
                      {selectedSession.inputTokens !== undefined && (() => {
                        const contextWindow = getModelContextWindow(selectedSession.model);
                        const pct = Math.min(100, (selectedSession.inputTokens / contextWindow) * 100);
                        const usedK = (selectedSession.inputTokens / 1000).toFixed(0);
                        const totalK = (contextWindow / 1000).toFixed(0);
                        const barColor = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e';
                        const compactCount = selectedSession.compactCount ?? 0;
                        return (
                          <div className={styles.field}>
                            <span className={styles.fieldLabel}>Context</span>
                            <span className={`${styles.fieldValue} ${styles.contextFieldValue}`}>
                              <span>
                                <span className={styles.contextText}>{usedK}k / {totalK}k</span> · {pct.toFixed(0)}%
                                {compactCount > 0 && (
                                  <span className={styles.compactInline}> · {compactCount}× compacted</span>
                                )}
                                {selectedSession.isCompacting && (
                                  <span className={styles.compactingBadge}> ● compacting</span>
                                )}
                              </span>
                              <div className={styles.contextBar}>
                                <div className={styles.contextBarFill} style={{ width: `${pct}%`, background: barColor }} />
                              </div>
                            </span>
                          </div>
                        );
                      })()}
                      {selectedSession.subagents.length > 0 && (() => {
                        const activeSubagents = selectedSession.subagents.filter(s => s.state !== 'idle');
                        const idleSubagents = selectedSession.subagents.filter(s => s.state === 'idle');
                        return (
                          <>
                            <div className={styles.detailsSubsection}>
                              Subagents ({selectedSession.subagents.length})
                            </div>
                            <ul className={styles.subagentList}>
                              {activeSubagents.map((sub) => (
                                <li key={sub.agentId} className={`${styles.subagentItem} ${sub.agentId === selectedSubagentId ? styles.subagentItemSelected : ''}`} style={{ cursor: 'pointer' }}>
                                  <span className={styles.subagentTreeNub} />
                                  <span className={styles.subagentDot} style={{ background: STATE_COLORS[sub.state] }} />
                                  <div className={styles.subagentInfo}>
                                    <span className={styles.subagentType}>{sub.agentType}</span>
                                    <span className={styles.subagentDesc}>{sub.description}</span>
                                  </div>
                                  <StateBadge state={sub.state} />
                                </li>
                              ))}
                            </ul>
                            {idleSubagents.length > 0 && (
                              <>
                                <button className={styles.collapseBtn} onClick={() => setShowIdleSubagents(!showIdleSubagents)}>
                                  {showIdleSubagents ? '▾' : '▸'} {idleSubagents.length} inactive
                                </button>
                                {showIdleSubagents && (
                                  <ul className={styles.subagentList}>
                                    {idleSubagents.map((sub) => (
                                      <li key={sub.agentId} className={styles.subagentItem} style={{ cursor: 'pointer' }}>
                                        <span className={styles.subagentTreeNub} />
                                        <span className={styles.subagentDot} style={{ background: STATE_COLORS[sub.state] }} />
                                        <div className={styles.subagentInfo}>
                                          <span className={styles.subagentType}>{sub.agentType}</span>
                                          <span className={styles.subagentDesc}>{sub.description}</span>
                                        </div>
                                        <StateBadge state={sub.state} />
                                        <span className={styles.subagentDoneLabel}>done</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {selectedSession.state === 'idle' && (
                    <div className={styles.continuationBanner}>
                      {siblingActiveSessions && siblingActiveSessions.length > 0 ? (
                        <>
                          <span className={styles.continuationLabel}>Session continued →</span>
                          <div className={styles.continuationList}>
                            {siblingActiveSessions.map(s => (
                              <button
                                key={s.sessionId}
                                className={styles.continuationBtn}
                                onClick={() => onSelectSession?.(s)}
                                style={{ borderColor: s.color, color: s.color }}
                              >
                                {customNames?.[s.sessionId] ?? s.proposedName ?? s.sessionId.slice(0, 8)}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <span className={styles.continuationLabel}>Session idle</span>
                      )}
                      {onResumeSession && (
                        <button
                          className={styles.resumeBtn}
                          onClick={() => onResumeSession(selectedSession.sessionId, selectedSession.cwd)}
                        >
                          ▶ Resume
                        </button>
                      )}
                    </div>
                  )}

                </div>

                {showSummary && (
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryCardHeader}>
                      <span className={styles.summaryCardTitle}>Summary</span>
                      {!summaryLoading && selectedSession && (
                        <button
                          className={styles.summaryCardRefresh}
                          onClick={() => fetchSummary(selectedSession.sessionId)}
                          title="Regenerate"
                        >↻</button>
                      )}
                    </div>
                    {summaryLoading ? (
                      <div className={styles.summaryCardLoading}>Generating summary…</div>
                    ) : summaryError ? (
                      <div className={styles.summaryCardError}>{summaryError}</div>
                    ) : summary ? (
                      <div
                        className={styles.summaryCardContent}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
                      />
                    ) : null}
                  </div>
                )}

                {isPty ? (
                  /* PTY: terminal fills the content area */
                  <div className={styles.scrollArea} ref={transcriptRef}>
                    <section className={styles.section}>
                      <XtermTerminal
                        sessionId={selectedSession.sessionId}
                        onInput={(data) => sendInput(selectedSession.sessionId, data)}
                        onResize={(cols, rows) => resizePty(selectedSession.sessionId, cols, rows)}
                        registerOutputHandler={registerOutputHandler}
                        isExited={isExited}
                      />
                    </section>
                  </div>
                ) : (
                  /* Non-PTY: transcript + pinned send input */
                  <>
                    <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleTranscriptScroll}>
                      {(mergedFeed.length > 0 || selectedSession.lastMessage) && (
                        <section className={styles.section}>
                          {mergedFeed.length > 0 ? (
                            <div className={styles.transcript}>
                              {renderSegments(
                                buildSegments(mergedFeed),
                                expandedToolGroups,
                                setExpandedToolGroups,
                                (role) => role === 'user' ? 'you' : 'claude',
                                styles as Record<string, string>,
                                expandedDiffs,
                                setExpandedDiffs,
                                rawSegments,
                                setRawSegments,
                              )}
                            </div>
                          ) : (
                            <div className={styles.messageBox}>{selectedSession.lastMessage}</div>
                          )}
                        </section>
                      )}
                    </div>
                    <div className={styles.sendArea}>
                      {getError(selectedSession.sessionId) && (
                        <div className={styles.sendError}>{getError(selectedSession.sessionId)}</div>
                      )}
                      {pastedImage && (
                        <div className={styles.imagePreview}>
                          <img src={pastedImage.previewUrl} alt="pasted" className={styles.imagePreviewImg} />
                          <button className={styles.imageRemoveBtn} onClick={() => setPastedImage(null)}>✕</button>
                        </div>
                      )}
                      <div className={styles.sendInputWrapper}>
                        <textarea
                          className={styles.sendTextarea}
                          value={sendInput2}
                          onChange={e => setSendInput2(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              const text = sendInput2.trim();
                              if (!text && !pastedImage) return;
                              if (!connected) return;
                              const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
                              injectText(selectedSession.sessionId, full, !!pastedImage);
                              setLocalSent(prev => [...prev, full]);
                              setSendInput2('');
                              setPastedImage(null);
                            }
                          }}
                          onPaste={async e => {
                            const imageItem = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
                            if (!imageItem) return;
                            e.preventDefault();
                            const blob = imageItem.getAsFile();
                            if (!blob) return;
                            const reader = new FileReader();
                            reader.onload = async () => {
                              try {
                                const base64 = (reader.result as string).split(',')[1];
                                const ext = imageItem.type === 'image/png' ? 'png' : 'jpg';
                                const res = await fetch('/api/paste-image', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ base64, ext }),
                                });
                                const data = await res.json() as { path: string; previewUrl: string };
                                setPastedImage(data);
                              } catch (err) {
                                console.error('[paste-image] failed:', err);
                              }
                            };
                            reader.readAsDataURL(blob);
                          }}
                          placeholder={connected ? 'Message… (Enter to send, paste image)' : 'Not connected'}
                          disabled={!connected}
                          rows={2}
                        />
                        <button
                          className={styles.sendButton}
                          onClick={() => {
                            const text = sendInput2.trim();
                            if (!text && !pastedImage) return;
                            if (!connected) return;
                            const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
                            injectText(selectedSession.sessionId, full, !!pastedImage);
                            setLocalSent(prev => [...prev, full]);
                            setSendInput2('');
                            setPastedImage(null);
                          }}
                          disabled={!connected || (!sendInput2.trim() && !pastedImage)}
                          title="Send (Enter)"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

          </>
        )}
      </div>
    </>
  );
}
