import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useTick } from '../hooks/useTick';
import type { Session, WorkerState, ActivityItem } from '../types';
import { getLaunchInfo } from '../types';
import { XtermTerminal } from './XtermTerminal';
import { WorkerAvatar } from './WorkerAvatar';
import { Worker } from './Worker';
import { ConsolePreview } from './ConsolePreview';
import styles from './DetailPanel.module.css';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

const MARKDOWN_CACHE_MAX = 500;
const markdownCache = new Map<string, string>();
function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const result = marked.parse(text) as string;
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    markdownCache.delete(markdownCache.keys().next().value!);
  }
  markdownCache.set(text, result);
  return result;
}

interface PtyHandlers {
  sendInput: (sessionId: string, data: string) => void;
  injectText: (sessionId: string, text: string, extraEnter?: boolean) => void;
  resizePty: (sessionId: string, cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => (() => void);
  exitedSessions: Set<string>;
  getError: (sessionId: string) => string | undefined;
}

interface SessionActions {
  onDeleteSession?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string, cwd: string) => void;
  onOpenInTerminal?: (sessionId: string, cwd: string) => void;
  onMarkDone?: (sessionId: string) => void;
  onAcceptSession?: (sessionId: string) => void;
  onAcceptTask?: (sessionId: string, completedAt: string) => void;
}

interface DetailPanelProps {
  selectedSession: Session | null;
  selectedSessionId?: string | null;
  selectedSubagentId?: string;
  customName?: string;
  onRename: (sessionId: string, name: string) => void;
  onClose: () => void;
  connected: boolean;
  isPtySession: (sessionId: string) => boolean;
  pty: PtyHandlers;
  actions: SessionActions;

  siblingActiveSessions?: Session[];
  onSelectSession?: (session: Session) => void;
  customNames?: Record<string, string>;
  panelWidth: number;
  onPanelWidthChange?: (width: number) => void;
}

function isFilePath(s: string): boolean {
  return /^([A-Za-z]:[/\\]|\/[^\s])/.test(s);
}


function trimPath(fullPath: string, cwd?: string): string {
  if (!cwd) return fullPath;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
  const normFull = norm(fullPath);
  const normCwd = norm(cwd);
  if (normFull.startsWith(normCwd + '/')) {
    return normFull.slice(normCwd.length + 1);
  }
  return fullPath;
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
  working: '#a78bfa',   // purple — actively running
  thinking: '#a78bfa',  // purple — processing
  waiting: '#f59e0b',   // amber — waiting for user input
  closed: '#374151',    // dark gray — not active
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

function useElapsedSeconds(isoTimestamp: string | undefined): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!isoTimestamp) return 0;
  return Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function PermissionPrompt({ sessionId, promptText, styles }: {
  sessionId: string;
  promptText?: string;
  styles: Record<string, string>;
}) {
  const [responding, setResponding] = React.useState(false);
  const [error, setError] = React.useState(false);

  const respond = async (text: string) => {
    setResponding(true);
    setError(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        console.error(`Permission respond failed: ${response.status} ${response.statusText}`);
        setError(true);
        setTimeout(() => setError(false), 3000);
      }
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className={styles.permissionPrompt}>
      {promptText && (
        <pre className={styles.permissionPromptText}>{promptText}</pre>
      )}
      <div className={styles.permissionPromptActions}>
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnYes}`}
          onClick={() => void respond('\r')}
          disabled={responding}
        >
          {error ? 'Failed' : 'Yes'}
        </button>
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnAlways}`}
          onClick={() => void respond('\x1b[B\r')}
          disabled={responding}
        >
          Yes, allow this session
        </button>
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnNo}`}
          onClick={() => void respond('\x1b')}
          disabled={responding}
        >
          No
        </button>
      </div>
    </div>
  );
}

function TaskHistory({ summaries, styles }: { summaries: Array<{ summary: string; completedAt: string }>; styles: Record<string, string> }) {
  const [expanded, setExpanded] = React.useState(false);
  const latest = summaries[summaries.length - 1];
  const prior = summaries.slice(0, -1).reverse();
  return (
    <div className={styles.taskHistory}>
      <div className={styles.taskHistoryLatest}>
        <span className={styles.taskHistoryText}>{latest.summary}</span>
        {prior.length > 0 && (
          <button className={styles.taskHistoryToggle} onClick={() => setExpanded(e => !e)}>
            {expanded ? 'hide history' : `+${prior.length} prior`}
          </button>
        )}
      </div>
      {expanded && (
        <div className={styles.taskHistoryList}>
          {prior.map((s, i) => (
            <div key={i} className={styles.taskHistoryItem}>
              <span className={styles.taskHistoryItemDot}>·</span>
              <span className={styles.taskHistoryItemText}>{s.summary}</span>
              <span className={styles.taskHistoryItemTime}>{new Date(s.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StateBadge({ state, activeSubagentCount, completionHint, userAccepted, onMarkDone, onAccept }: { state: WorkerState; activeSubagentCount?: number; completionHint?: 'done' | 'awaiting'; userAccepted?: boolean; onMarkDone?: () => void; onAccept?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const isDone = state === 'waiting' && completionHint === 'done';
  const color = isDone ? (userAccepted ? '#22c55e' : '#f59e0b') : STATE_COLORS[state];
  const label = isDone ? (userAccepted ? 'done ✓' : 'done · review') : state;

  const hasMenu = (isDone && !userAccepted && !!onAccept) || (!isDone && !!onMarkDone);

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span
          className={styles.stateBadge}
          style={{ background: color, color: '#1a1a2e', cursor: hasMenu ? 'pointer' : undefined }}
          onClick={hasMenu ? () => setMenuOpen(v => !v) : undefined}
        >
          {label}
        </span>
        {menuOpen && isDone && !userAccepted && onAccept && (
          <div className={styles.badgeDoneMenu} onMouseDown={e => e.stopPropagation()}>
            <button
              className={styles.badgeDoneBtn}
              onClick={() => { onAccept(); setMenuOpen(false); }}
            >
              ✓ Accept
            </button>
          </div>
        )}
        {menuOpen && !isDone && onMarkDone && (
          <div className={styles.badgeDoneMenu} onMouseDown={e => e.stopPropagation()}>
            <button
              className={styles.badgeDoneBtn}
              onClick={() => { onMarkDone(); setMenuOpen(false); }}
            >
              ✓ Mark as done
            </button>
          </div>
        )}
      </div>
      {activeSubagentCount != null && activeSubagentCount > 0 && (
        <span className={styles.delegateBadge}>↗ {activeSubagentCount}</span>
      )}
    </>
  );
}


type FeedSegment =
  | { type: 'message'; item: ActivityItem }
  | { type: 'toolGroup'; items: ActivityItem[] }
  | { type: 'thinking'; item: ActivityItem };

function buildSegments(feed: ActivityItem[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  for (const item of feed) {
    if (item.kind === 'tool') {
      const last = segments[segments.length - 1];
      if (last?.type === 'toolGroup' && item.toolName !== 'Agent') {
        last.items.push(item);
      } else {
        segments.push({ type: 'toolGroup', items: [item] });
      }
    } else if (item.kind === 'thinking') {
      segments.push({ type: 'thinking', item });
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

interface ToolEntryProps {
  tool: { toolName?: string; content?: string; inputJson?: string; durationMs?: number; oldString?: string; newString?: string };
  diffKey: string;
  argsKey: string;
  expandedDiffs: Set<string>;
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedArgs: Set<string>;
  setExpandedArgs: React.Dispatch<React.SetStateAction<Set<string>>>;
  ideName?: string;
  showRunning?: boolean;
  showDuration?: boolean;
  sessionState?: string;
  styles: Record<string, string>;
  cwd?: string;
}

function ToolEntry({
  tool,
  diffKey,
  argsKey,
  expandedDiffs,
  setExpandedDiffs,
  expandedArgs,
  setExpandedArgs,
  ideName,
  showRunning,
  showDuration,
  sessionState,
  styles,
  cwd,
}: ToolEntryProps) {
  const hasDiff = tool.toolName === 'Edit' && tool.oldString !== undefined;
  const isDiffExpanded = expandedDiffs.has(diffKey);
  const isArgsExpanded = expandedArgs.has(argsKey);
  return (
    <div className={styles.toolEntry}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        {tool.inputJson ? (
          <button
            className={styles.toolNameClickable}
            onClick={() => setExpandedArgs(prev => {
              const next = new Set(prev);
              if (next.has(argsKey)) next.delete(argsKey); else next.add(argsKey);
              return next;
            })}
          >
            ⚡ {tool.toolName}
          </button>
        ) : (
          <span className={styles.toolName}>⚡ {tool.toolName}</span>
        )}
        {showDuration && tool.durationMs !== undefined && tool.durationMs >= 2000 && (
          <span className={styles.toolDuration} title="Duration">
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 2, verticalAlign: -0.5 }}>
              <path d="M6.5.5a.5.5 0 00 0 1h3a.5.5 0 000-1zM8 3a6 6 0 100 12A6 6 0 008 3zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM8.25 5a.75.75 0 00-1.5 0v3.5c0 .414.336.75.75.75H10a.75.75 0 000-1.5H8.25z"/>
            </svg>
            took {(tool.durationMs / 1000).toFixed(1)}<span style={{ opacity: 0.6 }}>s</span>
          </span>
        )}
        {showRunning && sessionState === 'working' && tool.durationMs === undefined && (
          <span className={styles.toolRunningSpinner} />
        )}
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
      {tool.content && (
        isFilePath(tool.content)
          ? <button className={styles.toolDescLink} title={tool.content} onClick={(e) => { e.stopPropagation(); void fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tool.content, ideName }) }); }}>{trimPath(tool.content, cwd)}</button>
          : <span className={styles.toolDesc}>{tool.content}</span>
      )}
      {isArgsExpanded && tool.inputJson && (
        <pre className={styles.argsView}>{tool.inputJson}</pre>
      )}
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

function formatFeedTimestamp(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (isToday) return `${hh}:${mm}`;
  const dd = String(date.getDate()).padStart(2, '0');
  const mon = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mon}.${date.getFullYear()} ${hh}:${mm}`;
}

interface FeedSegmentsProps {
  feed: ActivityItem[];
  roleLabel: (role: string) => string;
  ideName?: string;
  sessionState?: WorkerState;
  styles: Record<string, string>;
  isPty?: boolean;
  cwd?: string;
}

function FeedSegments({ feed, roleLabel, ideName, sessionState, styles, isPty, cwd }: FeedSegmentsProps) {
  const segments = useMemo(() => buildSegments(feed), [feed]);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const [rawSegments, setRawSegments] = useState<Set<number>>(new Set());
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());

  return (
    <>
      {segments.map((seg, segIdx) => {
        if (seg.type === 'thinking') {
          const isExpanded = expandedThinking.has(segIdx);
          if (seg.item.isRedacted) {
            return (
              <div key={segIdx} className={styles.thinkingBlock}>
                <span className={styles.thinkingRedacted}>🔒 Thinking redacted</span>
              </div>
            );
          }
          return (
            <div key={segIdx} className={styles.thinkingBlock}>
              <button
                className={styles.thinkingToggle}
                onClick={() => setExpandedThinking(prev => {
                  const next = new Set(prev);
                  if (next.has(segIdx)) next.delete(segIdx); else next.add(segIdx);
                  return next;
                })}
              >
                <span className={styles.thinkingIcon}>💭</span>
                <span>{isExpanded ? 'Hide thinking' : 'Show thinking'}</span>
                <span className={styles.thinkingChevron}>{isExpanded ? '▴' : '▾'}</span>
              </button>
              {isExpanded && (
                <div className={styles.thinkingContent}>
                  {seg.item.content || <em>Empty</em>}
                </div>
              )}
            </div>
          );
        }
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
            <div key={segIdx} className={`${styles.transcriptEntry} ${styles[`role_${seg.item.role}`]} ${seg.item.pending ? styles.pendingMessage : ''}`}>
              {seg.item.pending && <span className={isPty ? styles.pendingBadge : styles.pendingBadgeConsole}>{isPty ? 'queued' : 'injecting'}</span>}
              <div className={styles.transcriptBubble}>
                {seg.item.role === 'assistant' || seg.item.role === 'user' ? (
                  <>
                    {isRaw ? (
                      <pre className={styles.rawContent}>{seg.item.content}</pre>
                    ) : (
                      <div
                        className={styles.markdownContent}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.item.content.trimEnd()) }}
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
                    {seg.item.timestamp && (
                      <span className={`${styles.feedTimestamp} ${seg.item.role === 'user' ? styles.feedTimestampUser : ''}`}>
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 3, verticalAlign: -1 }}>
                          <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 3a.75.75 0 01.75.75v3.69l2.28 2.28a.75.75 0 01-1.06 1.06l-2.5-2.5A.75.75 0 017.25 8V3.75A.75.75 0 018 3z"/>
                        </svg>
                        {formatFeedTimestamp(seg.item.timestamp)}
                      </span>
                    )}
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
          const argsKey = `${segIdx}-0-args`;
          const isLastSegment = segIdx === segments.length - 1;
          return (
            <ToolEntry
              key={segIdx}
              tool={tool}
              diffKey={diffKey}
              argsKey={argsKey}
              expandedDiffs={expandedDiffs}
              setExpandedDiffs={setExpandedDiffs}
              expandedArgs={expandedArgs}
              setExpandedArgs={setExpandedArgs}
              ideName={ideName}
              showRunning={isLastSegment}
              showDuration={true}
              sessionState={sessionState}
              styles={styles}
              cwd={cwd}
            />
          );
        }
        // Multi-tool group — collapsible, expanded only if in the set
        const isExpanded = expandedToolGroups.has(segIdx);
        const toolNames = seg.items.map(t => t.toolName ?? '').filter(Boolean);
        const summary = toolNames.length <= 3
          ? toolNames.join(', ')
          : toolNames.slice(0, 3).join(', ') + ` +${toolNames.length - 3}`;
        const isLastSegment = segIdx === segments.length - 1;
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
              {isLastSegment && sessionState === 'working' && seg.items.every(t => t.durationMs === undefined) && (
                <span className={styles.toolRunningSpinner} />
              )}
              <span className={styles.toolGroupChevron}>{isExpanded ? '▾' : '▸'}</span>
            </button>
            {isExpanded && seg.items.map((tool, ti) => {
              const diffKey = `${segIdx}-${ti}`;
              const argsKey = `${segIdx}-${ti}-args`;
              return (
                <ToolEntry
                  key={ti}
                  tool={tool}
                  diffKey={diffKey}
                  argsKey={argsKey}
                  expandedDiffs={expandedDiffs}
                  setExpandedDiffs={setExpandedDiffs}
                  expandedArgs={expandedArgs}
                  setExpandedArgs={setExpandedArgs}
                  ideName={ideName}
                  showRunning={false}
                  showDuration={false}
                  sessionState={sessionState}
                  styles={styles}
                  cwd={cwd}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}

const STATE_ICONS: Record<string, string> = {
  working: '⚙',
  thinking: '💭',
  waiting: '⏳',
  closed: '✓',
  abandoned: '⚠',
};

export function DetailPanel({
  selectedSession,
  selectedSubagentId,
  customName,
  onRename,
  onClose,
  connected,
  isPtySession,
  pty,
  actions,

  siblingActiveSessions,
  onSelectSession,
  customNames,
  panelWidth,
  onPanelWidthChange,
}: DetailPanelProps) {
  const { sendInput, injectText, resizePty, registerOutputHandler, exitedSessions, getError } = pty;
  const { onDeleteSession, onResumeSession, onOpenInTerminal, onMarkDone, onAcceptSession, onAcceptTask } = actions;
  const isOpen = selectedSession !== null;

  // Re-render every second to update duration / relative times — only when panel is open
  useTick(selectedSession ? 1000 : null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  function setPanelWidth(next: number) {
    onPanelWidthChange?.(next);
  }
  const dragStartX = useRef<number | null>(null);
  const dragStartWidth = useRef<number>(panelWidth);
  const currentDragWidth = useRef<number>(panelWidth);

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    currentDragWidth.current = panelWidth;

    function onMouseMove(ev: MouseEvent) {
      if (dragStartX.current === null) return;
      const delta = dragStartX.current - ev.clientX;
      const next = Math.max(320, Math.min(900, dragStartWidth.current + delta));
      currentDragWidth.current = next;
      setPanelWidth(next);
    }

    function onMouseUp() {
      dragStartX.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem('overlord:panelWidth', String(currentDragWidth.current));
      onPanelWidthChange?.(currentDragWidth.current);
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

  const [activeTab, setActiveTab] = useState<'conversation' | 'details' | 'tasks' | 'subagents' | 'terminal'>('conversation');
  const [subagentActiveTab, setSubagentActiveTab] = useState<'conversation' | 'details'>('conversation');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [showIdleSubagents, setShowIdleSubagents] = useState(false);
  const [localSent, setLocalSent] = useState<string[]>([]);
  const realCountAtFirstSend = useRef<number | null>(null);
  const [sendInput2, setSendInput2] = useState('');
  const [showConvoResumePrompt, setShowConvoResumePrompt] = useState(false);
  const [pastedImage, setPastedImage] = useState<{ path: string; previewUrl: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyConfirm, setCopyConfirm] = useState(false);
  const [copyIdConfirm, setCopyIdConfirm] = useState(false);
  const [killing, setKilling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const currentDisplayName =
    customName ??
    selectedSession?.proposedName ??
    selectedSession?.slug ??
    (selectedSession?.sessionId.slice(0, 8) ?? '');

  const selectedSubagent = selectedSubagentId
    ? selectedSession?.subagents.find(s => s.agentId === selectedSubagentId)
    : undefined;

  const elapsedSeconds = useElapsedSeconds(selectedSession?.lastActivity);

  // Auto-scroll when feed changes, only if already at bottom
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    // Double rAF: wait for React render + browser layout/paint before scrolling
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedSession?.activityFeed, selectedSubagent?.activityFeed, activeTab]);

  // Force scroll to bottom when user sends a message
  useEffect(() => {
    if (localSent.length === 0) return;
    isAtBottomRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
  }, [localSent.length]);

  // Reset scroll to bottom and edit state when selected session/subagent changes
  useEffect(() => {
    isAtBottomRef.current = true;
    // Double rAF: wait for React render + browser layout/paint before scrolling
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
    setIsEditing(false);
    setEditValue('');
    setLocalSent([]);
    setSendInput2('');
    setConfirmDelete(false);
    setCopyConfirm(false);
    setPastedImage(null);
    setKilling(false);
    setResuming(false);
    setActiveTab('conversation');
    setSubagentActiveTab('conversation');
    return () => cancelAnimationFrame(raf);
  }, [selectedSession?.sessionId, selectedSubagentId]);

  function startEdit() {
    setEditValue(currentDisplayName);
    setIsEditing(true);
  }

  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.select();
    }
  }, [isEditing]);

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

  function handleSend() {
    if (!selectedSession) return;
    const text = sendInput2.trim();
    if (!text && !pastedImage) return;
    const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
    injectText(selectedSession.sessionId, full, !!pastedImage);
    if (full) {
      // Snapshot real user message count on first pending send
      if (realCountAtFirstSend.current === null) {
        const feed = selectedSession.activityFeed ?? [];
        realCountAtFirstSend.current = feed.filter(i => i.role === 'user').length;
      }
      setLocalSent(prev => [...prev, full]);
    }
    setSendInput2('');
    setPastedImage(null);
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
  const sessionError = selectedSession ? getError(selectedSession.sessionId) : undefined;


  // Clear stale pending messages after 30s (safety net — content de-duplication handles normal flow)
  useEffect(() => {
    if (localSent.length === 0) return;
    const timer = setTimeout(() => setLocalSent([]), 30_000);
    return () => clearTimeout(timer);
  }, [localSent]);

  // Build merged activityFeed: real feed + optimistic locally-sent messages
  // Count-based: track how many new user messages appeared since we started sending
  const realFeed = selectedSession?.activityFeed ?? [];
  const currentRealUserCount = realFeed.filter(i => i.role === 'user').length;
  const confirmed = realCountAtFirstSend.current !== null
    ? Math.max(0, currentRealUserCount - realCountAtFirstSend.current)
    : 0;
  const pendingMessages = localSent.slice(confirmed);
  // If all confirmed, reset tracking
  if (confirmed >= localSent.length && localSent.length > 0) {
    // Use queueMicrotask to avoid setState during render
    queueMicrotask(() => {
      setLocalSent([]);
      realCountAtFirstSend.current = null;
    });
  }
  const mergedFeed: ActivityItem[] = [
    ...realFeed,
    ...pendingMessages.map(t => ({ kind: 'message' as const, role: 'user' as const, content: t.slice(0, 200), pending: true })),
  ];

  const lastUserMessage = [...mergedFeed].reverse().find(m => m.kind === 'message' && m.role === 'user')?.content ?? '';
  const isAbandoned = selectedSession != null && selectedSession.state === 'closed' && (Date.now() - new Date(selectedSession.lastActivity).getTime()) > 30 * 60 * 1000;
  const summaryState = isAbandoned ? 'abandoned' : (selectedSession?.state ?? 'closed');
  const hasSubagents = (selectedSession?.subagents.length ?? 0) > 0;

  const stateBarActiveSubagents = selectedSession
    ? selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking')
    : [];
  const stateBarIsDone = selectedSession?.state === 'waiting' && selectedSession?.completionHint === 'done';
  const stateBarNeedsApproval = selectedSession?.needsPermission === true;
  const stateBarLabel = stateBarIsDone ? 'Task complete'
    : stateBarNeedsApproval ? 'Waiting for approval'
    : selectedSession?.state === 'waiting' && stateBarActiveSubagents.length > 0 ? 'Delegated · waiting for subagent'
    : selectedSession?.state === 'waiting' ? 'Waiting for your response'
    : selectedSession?.state === 'thinking' ? 'Thinking...'
    : 'Working...';
  const stateBarClass = stateBarIsDone ? styles.stateBarDone
    : stateBarNeedsApproval ? styles.stateBarPermission
    : selectedSession?.state === 'waiting' ? styles.stateBarWaiting
    : selectedSession?.state === 'thinking' ? styles.stateBarThinking
    : styles.stateBarActive;

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
                  <div className={styles.headerWithAvatar}>
                    <WorkerAvatar
                      sessionId={selectedSubagent.agentId}
                      color={selectedSession.color}
                      size={44}
                    />
                    <div className={styles.headerMain}>
                      <h2 className={styles.sessionName}>{selectedSubagent.description || selectedSubagent.agentType}</h2>
                      <div className={styles.summaryRow}>
                        <StateBadge state={selectedSubagent.state} />
                        <span className={styles.summaryMeta}>{formatRelativeTime(selectedSubagent.lastActivity)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Subagent tab bar */}
                <div className={styles.tabBar}>
                  <button
                    className={`${styles.tab} ${subagentActiveTab === 'conversation' ? styles.tabActive : ''}`}
                    onClick={() => setSubagentActiveTab('conversation')}
                  >
                    Conversation
                  </button>
                  <button
                    className={`${styles.tab} ${subagentActiveTab === 'details' ? styles.tabActive : ''}`}
                    onClick={() => setSubagentActiveTab('details')}
                  >
                    Details
                  </button>
                </div>

                {subagentActiveTab === 'conversation' ? (
                  <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleTranscriptScroll}>
                    <section className={styles.section}>
                      {selectedSubagent.activityFeed?.length ? (
                        <div className={styles.transcript}>
                          <FeedSegments
                            feed={selectedSubagent.activityFeed}
                            roleLabel={(role) => role === 'user' ? 'parent' : 'claude'}
                            styles={styles as Record<string, string>}
                            ideName={selectedSession.ideName}
                            sessionState={selectedSubagent.state}
                            cwd={selectedSession.cwd}
                          />
                        </div>
                      ) : (
                        <div className={styles.messageBox}>No activity recorded yet.</div>
                      )}
                    </section>
                  </div>
                ) : (
                  /* Subagent details tab */
                  <div className={styles.scrollArea}>
                    <section className={styles.section}>
                      <div className={styles.detailsExpanded} style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>State</span>
                          <span className={styles.fieldValue}><StateBadge state={selectedSubagent.state} /></span>
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
                        {selectedSubagent.model && (
                          <div className={styles.field}>
                            <span className={styles.fieldLabel}>Model</span>
                            <span className={styles.fieldValue}>{selectedSubagent.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                          </div>
                        )}
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Agent ID</span>
                          <span className={styles.fieldValue}>{selectedSubagent.agentId.slice(0, 8)}</span>
                        </div>
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Last activity</span>
                          <span className={styles.fieldValue}>{formatRelativeTime(selectedSubagent.lastActivity)}</span>
                        </div>
                      </div>
                    </section>
                  </div>
                )}
              </>
            ) : (
              /* Session view */
              <>
                {/* Sticky header */}
                <div className={styles.panelHeader}>
                  <div className={styles.headerWithAvatar}>
                    <WorkerAvatar sessionId={selectedSession.sessionId} color={selectedSession.color} size={44} />
                  <div className={styles.headerMain}>
                  <div className={styles.nameRow}>
                    {isEditing ? (
                      <>
                        <input
                          ref={editInputRef}
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
                        <h2 className={styles.sessionName} onDoubleClick={startEdit} title="Double-click to rename">{currentDisplayName}</h2>
                        <button
                          className={styles.nameBtn}
                          onClick={() => navigator.clipboard.writeText(selectedSession.sessionId)}
                          title={`Copy session ID: ${selectedSession.sessionId}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/>
                            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/>
                          </svg>
                        </button>
                      </>
                    )}
                  </div>

                  <div className={styles.summaryRow}>
                    <StateBadge
                      state={selectedSession.state}
                      activeSubagentCount={selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking').length || undefined}
                      completionHint={selectedSession.completionHint}
                      userAccepted={selectedSession.userAccepted}
                      onMarkDone={(() => {
                        const canMarkDone = selectedSession.state !== 'closed' && selectedSession.completionHint !== 'done' && !!onMarkDone;
                        return canMarkDone ? () => onMarkDone(selectedSession.sessionId) : undefined;
                      })()}
                      onAccept={(() => {
                        const isDone = selectedSession.completionHint === 'done' && !selectedSession.userAccepted;
                        return isDone && !!onAcceptSession ? () => onAcceptSession(selectedSession.sessionId) : undefined;
                      })()}
                    />
                    {selectedSession.startedAt > 0 && (
                      <span className={styles.summaryMeta}>{formatStartedAt(selectedSession.startedAt)}</span>
                    )}
                    <span className={`${styles.summaryMeta} ${styles.summaryMetaAgo}`}>{formatRelativeTime(selectedSession.lastActivity)}</span>
                    {selectedSession.model && <span className={styles.summaryMeta}>{selectedSession.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>}
                  </div>
                  </div>{/* headerMain */}
                  </div>{/* headerWithAvatar */}
                </div>

                {/* Tab bar */}
                <div className={styles.tabBar}>
                  <button
                    className={`${styles.tab} ${activeTab === 'conversation' ? styles.tabActive : ''}`}
                    onClick={() => setActiveTab('conversation')}
                  >
                    Conversation
                  </button>
                  <button
                    className={`${styles.tab} ${activeTab === 'details' ? styles.tabActive : ''}`}
                    onClick={() => setActiveTab('details')}
                  >
                    Details
                  </button>
                  {selectedSession.completionSummaries && selectedSession.completionSummaries.length > 0 && (
                    <button
                      className={`${styles.tab} ${activeTab === 'tasks' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('tasks')}
                    >
                      Tasks
                    </button>
                  )}
                  {hasSubagents && (
                    <button
                      className={`${styles.tab} ${activeTab === 'subagents' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('subagents')}
                    >
                      Subagents
                    </button>
                  )}
                  {(isPty || selectedSession.launchMethod === 'overlord-pty') && (
                    <button
                      className={`${styles.tab} ${activeTab === 'terminal' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('terminal')}
                    >
                      Terminal
                      {isPty ? (
                        <span className={styles.tabPtyBadge}>PTY</span>
                      ) : (
                        <>
                          <span className={styles.tabPtyBadgeEnded}>PTY</span>
                          <span style={{ fontSize: '10px', color: '#666' }}>(ended)</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Tab: Conversation */}
                {activeTab === 'conversation' && (
                  <>
                    {/* Non-PTY: transcript + state bar + send input */}
                      <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleTranscriptScroll}>
                        {(mergedFeed.length > 0 || selectedSession.lastMessage) && (
                          <section className={styles.section}>
                            {mergedFeed.length > 0 ? (
                              <div className={styles.transcript}>
                                <FeedSegments
                                  feed={mergedFeed}
                                  roleLabel={(role) => role === 'user' ? 'you' : 'claude'}
                                  styles={styles as Record<string, string>}
                                  ideName={selectedSession.ideName}
                                  sessionState={selectedSession.state}
                                  isPty={isPty}
                                  cwd={selectedSession.cwd}
                                />
                              </div>
                            ) : (
                              <div className={styles.messageBox}>{selectedSession.lastMessage}</div>
                            )}
                          </section>
                        )}
                      </div>
                      <ConsolePreview
                        sessionId={selectedSession.sessionId}
                        sessionState={selectedSession.state}
                        isPty={isPty}
                        launchMethod={selectedSession.launchMethod}
                      />
                      {selectedSession && selectedSession.state !== 'closed' && (
                        <>
                          <div className={`${styles.stateBar} ${stateBarClass}`}>
                            <span className={styles.stateBarDot} />
                            <span className={styles.stateBarLabel}>{stateBarLabel}</span>
                            {stateBarActiveSubagents.length > 0 && (
                              <span className={styles.stateBarDelegate}>
                                · {stateBarActiveSubagents.length} delegated
                              </span>
                            )}
                            <div style={{flex: 1}} />
                            {(selectedSession.state === 'thinking' || selectedSession.state === 'working') && elapsedSeconds > 2 && (
                              <span className={styles.stateBarElapsed}>{formatElapsed(elapsedSeconds)}</span>
                            )}
                            {stateBarIsDone && !selectedSession.userAccepted && onAcceptSession && (
                              <button
                                className={styles.acceptBtn}
                                onClick={() => onAcceptSession(selectedSession.sessionId)}
                                title="Accept this completed session"
                              >
                                Accept
                              </button>
                            )}
                            {stateBarIsDone && selectedSession.userAccepted && (
                              <span className={styles.acceptedLabel}>Accepted ✓</span>
                            )}
                          </div>
                          {stateBarNeedsApproval && (
                            <PermissionPrompt
                              sessionId={selectedSession.sessionId}
                              promptText={selectedSession.permissionPromptText}
                              styles={styles}
                            />
                          )}
                        </>
                      )}
                      {(selectedSession.state === 'working' || selectedSession.state === 'thinking') && (
                        <div className={styles.interruptBar}>
                          <span className={styles.interruptLabel}>Session is {selectedSession.state}…</span>
                          <button
                            className={styles.interruptBtn}
                            onClick={async () => {
                              try {
                                await fetch(`/api/sessions/${selectedSession.sessionId}/inject`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ text: '\x1b' }),
                                });
                              } catch (err) {
                                console.error('Interrupt failed:', err);
                              }
                            }}
                          >
                            ■ Interrupt
                          </button>
                          <button
                            className={styles.forceStopBtn}
                            onClick={async () => {
                              try {
                                await fetch(`/api/sessions/${selectedSession.sessionId}/inject`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ text: '\x03' }),
                                });
                              } catch (err) {
                                console.error('Force stop failed:', err);
                              }
                            }}
                          >
                            Force Stop
                          </button>
                        </div>
                      )}
                      <div className={`${styles.sendArea} ${selectedSession.state === 'closed' ? styles.sendAreaClosed : ''}`}>
                        {sessionError && (
                          <div className={styles.sendError}>{sessionError}</div>
                        )}
                        {showConvoResumePrompt && onResumeSession && selectedSession.state === 'closed' && (
                          <div className={styles.convoResumeOverlay}>
                            <div className={styles.convoResumePrompt}>
                              <span className={styles.convoResumeText}>
                                This session has exited. Resume it?
                              </span>
                              <div className={styles.convoResumeActions}>
                                <button
                                  className={styles.convoResumeButtonPrimary}
                                  onClick={() => { setShowConvoResumePrompt(false); onResumeSession(selectedSession.sessionId, selectedSession.cwd); }}
                                >
                                  Resume Session
                                </button>
                                <button
                                  className={styles.convoResumeButtonSecondary}
                                  onClick={() => setShowConvoResumePrompt(false)}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                        {pastedImage && (
                          <div className={styles.imagePreview}>
                            <img src={pastedImage.previewUrl} alt="pasted" className={styles.imagePreviewImg} />
                            <button className={styles.imageRemoveBtn} onClick={() => setPastedImage(null)}>✕</button>
                          </div>
                        )}
                        <div className={styles.sendInputWrapper}>
                          <textarea
                            className={`${styles.sendTextarea} ${selectedSession.state === 'closed' ? styles.sendTextareaClosed : ''}`}
                            value={sendInput2}
                            onChange={e => setSendInput2(e.target.value)}
                            onKeyDown={e => {
                              if (selectedSession.state === 'closed') {
                                e.preventDefault();
                                if (onResumeSession) setShowConvoResumePrompt(true);
                                return;
                              }
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (!connected) return;
                                const text = sendInput2.trim();
                                if (!text && !pastedImage) {
                                  // bare Enter — send \r to confirm a prompt (e.g. permission dialog)
                                  injectText(selectedSession.sessionId, '', false);
                                  return;
                                }
                                handleSend();
                              }
                            }}
                            onFocus={() => {
                              if (selectedSession.state === 'closed' && onResumeSession) {
                                setShowConvoResumePrompt(true);
                              }
                            }}
                            onPaste={async e => {
                              if (selectedSession.state === 'closed') {
                                e.preventDefault();
                                if (onResumeSession) setShowConvoResumePrompt(true);
                                return;
                              }
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
                            placeholder={selectedSession.state === 'closed' ? 'Session exited — click to resume' : (connected ? 'Message… (Enter to send, paste image)' : 'Not connected')}
                            disabled={!connected}
                            rows={2}
                          />
                          <button
                            className={styles.sendButton}
                            onClick={() => {
                              if (selectedSession.state === 'closed') {
                                if (onResumeSession) setShowConvoResumePrompt(true);
                                return;
                              }
                              if (!connected) return;
                              handleSend();
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

                {/* Tab: Terminal */}
                {activeTab === 'terminal' && (isPty || selectedSession.launchMethod === 'overlord-pty') && (
                  isPty ? (
                    <div className={styles.terminalContent}>
                      <XtermTerminal
                        sessionId={selectedSession.sessionId}
                        onInput={(data) => sendInput(selectedSession.sessionId, data)}
                        onResize={(cols, rows) => resizePty(selectedSession.sessionId, cols, rows)}
                        registerOutputHandler={registerOutputHandler}
                        isExited={isExited || selectedSession.state === 'closed'}
                        onResume={
                          onResumeSession
                            ? () => onResumeSession(selectedSession.sessionId, selectedSession.cwd)
                            : undefined
                        }
                        fillHeight
                      />
                    </div>
                  ) : (
                    <div className={styles.terminalEndedNotice}>
                      <span className={styles.terminalEndedIcon}>⊘</span>
                      <span>PTY session has ended</span>
                      <span className={styles.terminalEndedHint}>This session was launched from Overlord but the terminal connection is no longer active.</span>
                      {onResumeSession && (
                        <button
                          className={styles.reattachBtn}
                          onClick={() => onResumeSession(selectedSession.sessionId, selectedSession.cwd)}
                        >
                          Resume in new PTY
                        </button>
                      )}
                    </div>
                  )
                )}

                {/* Tab: Details */}
                {activeTab === 'details' && (
                  <div className={styles.scrollArea}>
                    <section className={styles.section}>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>ID</span>
                        <span className={styles.fieldValue} title={selectedSession.sessionId}>
                          {selectedSession.sessionId.slice(0, 8)}
                          <span className={styles.compactInline}> · PID {selectedSession.pid}</span>
                          <button
                            className={styles.copyIdButton}
                            style={copyIdConfirm ? { color: '#22c55e', opacity: 1 } : undefined}
                            title="Copy full session ID"
                            onClick={() => {
                              void navigator.clipboard.writeText(selectedSession.sessionId);
                              setCopyIdConfirm(true);
                              setTimeout(() => setCopyIdConfirm(false), 2000);
                            }}
                          >
                            {copyIdConfirm ? (
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <path d="M2 6.5L4.5 9L10 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <rect x="4.5" y="1.5" width="6" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                                <path d="M7.5 1.5V1a.5.5 0 0 0-.5-.5H2A1 1 0 0 0 1 1.5V9a.5.5 0 0 0 .5.5H3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                              </svg>
                            )}
                          </button>
                          {selectedSession.state !== 'closed' && (
                            <button
                              className={styles.killPidButton}
                              title={`Kill process (PID ${selectedSession.pid})`}
                              disabled={killing}
                              onClick={() => {
                                setKilling(true);
                                fetch(`/api/sessions/${selectedSession.sessionId}/kill-process`, { method: 'POST' })
                                  .catch(console.error)
                                  .finally(() => setKilling(false));
                              }}
                            >
                              {killing ? '…' : '✕'}
                            </button>
                          )}
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
                      {(() => {
                        const launch = getLaunchInfo(selectedSession, isPty);
                        return (
                          <div className={styles.field}>
                            <span className={styles.fieldLabel}>Launched from</span>
                            {launch.category === 'pty' ? (
                              <span className={isPty ? styles.overlordPill : styles.overlordPillEnded}>
                                <span className={`${styles.statusDot} ${isPty ? styles.statusDotActive : styles.statusDotEnded}`} />
                                Overlord {isPty ? '(active)' : '(ended)'}
                              </span>
                            ) : (
                              <span className={styles.fieldValue}>{launch.name}</span>
                            )}
                          </div>
                        );
                      })()}
                      {selectedSession.resumedFrom && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Resumed from</span>
                          <span
                            className={styles.detailLink}
                            title={selectedSession.resumedFrom}
                          >
                            {customNames?.[selectedSession.resumedFrom] ?? selectedSession.resumedFrom.slice(0, 8)}
                          </span>
                        </div>
                      )}
                      {selectedSession.model && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Model</span>
                          <span className={styles.fieldValue}>{selectedSession.model.replace('claude-', '')}</span>
                        </div>
                      )}
                      {selectedSession.inputTokens !== undefined && (() => {
                        const contextWindow = 200_000;
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

                      {/* Continuation banner */}
                      {selectedSession.state === 'closed' && (
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
                            <span className={styles.continuationLabel}>Session closed</span>
                          )}
                        </div>
                      )}

                      {/* Resume / Connect section */}
                      {(
                        <div className={styles.resumeSection}>
                          <div className={styles.resumeSectionLabel}>{selectedSession.state === 'closed' ? 'Resume' : 'Connect'}</div>
                          <div className={styles.resumeCommand}>
                            <code>claude --resume {selectedSession.sessionId} --name &quot;{currentDisplayName}&quot;</code>
                            <button
                              className={styles.resumeCopyIcon}
                              onClick={() => {
                                navigator.clipboard.writeText(`claude --resume ${selectedSession.sessionId} --name "${currentDisplayName}"`);
                                setCopyConfirm(true);
                                setTimeout(() => setCopyConfirm(false), 2000);
                              }}
                              title="Copy"
                            >
                              {copyConfirm ? (
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12"/>
                                </svg>
                              ) : (
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                              )}
                            </button>
                          </div>
                          <div className={styles.resumeButtons}>
                            {onResumeSession && (
                              <button
                                className={`${styles.resumeButton} ${resuming ? styles.resumeButtonPending : ''}`}
                                disabled={resuming}
                                onClick={() => {
                                  setResuming(true);
                                  onResumeSession(selectedSession.sessionId, selectedSession.cwd);
                                }}
                              >
                                {resuming ? 'Starting…' : selectedSession.state === 'closed' ? 'Resume in Overlord' : 'Attach in Overlord'}
                              </button>
                            )}
                            {onOpenInTerminal && (
                              <button
                                className={`${styles.resumeButton} ${openingTerminal ? styles.resumeButtonPending : ''}`}
                                disabled={openingTerminal}
                                onClick={() => {
                                  setOpeningTerminal(true);
                                  onOpenInTerminal(selectedSession.sessionId, selectedSession.cwd);
                                  setTimeout(() => setOpeningTerminal(false), 2000);
                                }}
                              >
                                {openingTerminal ? 'Opening…' : selectedSession.state === 'closed' ? 'Open in Terminal' : 'Attach in Terminal'}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {/* Tab: Tasks */}
                {activeTab === 'tasks' && (
                  <div className={styles.scrollArea}>
                    <section className={styles.section}>
                      {(!selectedSession.completionSummaries || selectedSession.completionSummaries.length === 0) && !lastUserMessage ? (
                        <div className={styles.messageBox}>No tasks yet.</div>
                      ) : (
                        <div className={styles.summaryList}>
                          {lastUserMessage && (
                            <div className={`${styles.summaryRow_} ${styles.summaryRowActive}`}>
                              <span className={styles.summaryRowIcon}>{STATE_ICONS[summaryState]}</span>
                              <span className={styles.summaryRowText}>
                                {lastUserMessage.length > 120 ? lastUserMessage.slice(0, 120) + '…' : lastUserMessage}
                              </span>
                              <span className={styles.summaryRowTime}>now</span>
                            </div>
                          )}
                          {[...(selectedSession.completionSummaries ?? [])].reverse().map((item, i) => (
                            <div key={i} className={styles.summaryRow_}>
                              <span className={styles.summaryRowIcon} style={{ color: item.accepted ? '#22c55e' : '#f59e0b' }}>✓</span>
                              <span className={styles.summaryRowText}>{item.summary}</span>
                              {!item.accepted && (
                                <span style={{ fontSize: '11px', color: '#f59e0b', opacity: 0.8, marginRight: 4 }}>· review</span>
                              )}
                              <span className={styles.summaryRowTime}>{formatRelativeTime(item.completedAt)}</span>
                              {!item.accepted && (
                                <button
                                  className={styles.summaryRowAcceptBtn}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onAcceptTask?.(selectedSession.sessionId, item.completedAt);
                                  }}
                                >
                                  Accept
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {/* Tab: Subagents */}
                {activeTab === 'subagents' && hasSubagents && (
                  <div className={styles.scrollArea}>
                    <section className={styles.section}>
                      {(() => {
                        const activeSubagents = selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking');
                        const idleSubagents = selectedSession.subagents.filter(s => s.state === 'closed');
                        return (
                          <>
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
                    </section>
                  </div>
                )}

              </>
            )}

          </>
        )}
      </div>
    </>
  );
}
