import React, { useEffect, useState, useRef } from 'react';
import type { Session, WorkerState, ActivityItem } from '../types';
import { XtermTerminal } from './XtermTerminal';
import { WorkerAvatar } from './WorkerAvatar';
import { Worker } from './Worker';
import styles from './DetailPanel.module.css';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
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
  onMarkDone?: (sessionId: string) => void;
  onAcceptSession?: (sessionId: string) => void;
  onAcceptTask?: (sessionId: string, completedAt: string) => void;
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

function isFilePath(s: string): boolean {
  return /^([A-Za-z]:[/\\]|\/[^\s])/.test(s);
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
  | { type: 'toolGroup'; items: ActivityItem[] }
  | { type: 'thinking'; item: ActivityItem };

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
  expandedThinking: Set<number>,
  setExpandedThinking: React.Dispatch<React.SetStateAction<Set<number>>>,
  expandedArgs: Set<string>,
  setExpandedArgs: React.Dispatch<React.SetStateAction<Set<string>>>,
  ideName?: string,
  sessionState?: WorkerState,
): React.ReactNode[] {
  return segments.map((seg, segIdx) => {
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
        <div key={segIdx} className={`${styles.transcriptEntry} ${styles[`role_${seg.item.role}`]}`}>
          <div className={styles.transcriptBubble}>
            {seg.item.role === 'assistant' || seg.item.role === 'user' ? (
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
      const argsKey = `${segIdx}-0-args`;
      const hasDiff = tool.toolName === 'Edit' && tool.oldString !== undefined;
      const isDiffExpanded = expandedDiffs.has(diffKey);
      const isArgsExpanded = expandedArgs.has(argsKey);
      const isLastSegment = segIdx === segments.length - 1;
      return (
        <div key={segIdx} className={styles.toolEntry}>
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
            {tool.durationMs !== undefined && tool.durationMs >= 2000 && (
              <span className={styles.toolDuration}>{(tool.durationMs / 1000).toFixed(1)}s</span>
            )}
            {isLastSegment && sessionState === 'working' && tool.durationMs === undefined && (
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
              ? <button className={styles.toolDescLink} title="Open file" onClick={(e) => { e.stopPropagation(); void fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tool.content, ideName }) }); }}>{tool.content}</button>
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
          const hasDiff = tool.toolName === 'Edit' && tool.oldString !== undefined;
          const isDiffExpanded = expandedDiffs.has(diffKey);
          const isArgsExpanded = expandedArgs.has(argsKey);
          return (
            <div key={ti} className={styles.toolEntry}>
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
              ? <button className={styles.toolDescLink} title="Open file" onClick={(e) => { e.stopPropagation(); void fetch('/api/open-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tool.content, ideName }) }); }}>{tool.content}</button>
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
  onMarkDone,
  onAcceptSession,
  onAcceptTask,
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

  const [activeTab, setActiveTab] = useState<'conversation' | 'details' | 'tasks' | 'subagents' | 'terminal'>('conversation');
  const [subagentActiveTab, setSubagentActiveTab] = useState<'conversation' | 'details'>('conversation');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [showIdleSubagents, setShowIdleSubagents] = useState(false);
  const [localSent, setLocalSent] = useState<string[]>([]);
  const [sendInput2, setSendInput2] = useState('');
  const [pastedImage, setPastedImage] = useState<{ path: string; previewUrl: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyConfirm, setCopyConfirm] = useState(false);
  const [copyIdConfirm, setCopyIdConfirm] = useState(false);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const [rawSegments, setRawSegments] = useState<Set<number>>(new Set());
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());
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
          transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedSession?.activityFeed, selectedSubagent?.activityFeed]);

  // Reset scroll to bottom and edit state when selected session/subagent changes
  useEffect(() => {
    isAtBottomRef.current = true;
    // Double rAF: wait for React render + browser layout/paint before scrolling
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
        }
      });
    });
    setIsEditing(false);
    setEditValue('');
    setLocalSent([]);
    setSendInput2('');
    setConfirmDelete(false);
    setCopyConfirm(false);
    setExpandedToolGroups(new Set());
    setExpandedDiffs(new Set());
    setRawSegments(new Set());
    setExpandedThinking(new Set());
    setPastedImage(null);
    setActiveTab(selectedSession?.sessionId && isPtySession(selectedSession.sessionId) ? 'terminal' : 'conversation');
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

  const lastUserMessage = [...mergedFeed].reverse().find(m => m.kind === 'message' && m.role === 'user')?.content ?? '';
  const isAbandoned = selectedSession != null && selectedSession.state === 'closed' && (Date.now() - new Date(selectedSession.lastActivity).getTime()) > 30 * 60 * 1000;
  const summaryState = isAbandoned ? 'abandoned' : (selectedSession?.state ?? 'closed');
  const STATE_ICONS: Record<string, string> = {
    working: '⚙',
    thinking: '💭',
    waiting: '⏳',
    closed: '✓',
    abandoned: '⚠',
  };

  const hasSubagents = (selectedSession?.subagents.length ?? 0) > 0;

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
                            expandedThinking,
                            setExpandedThinking,
                            expandedArgs,
                            setExpandedArgs,
                            selectedSession.ideName,
                            selectedSubagent.state,
                          )}
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
                    <span className={styles.summaryMeta}>{formatRelativeTime(selectedSession.lastActivity)}</span>
                    {selectedSession.model && <span className={styles.summaryMeta}>{selectedSession.model.replace('claude-', '')}</span>}
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
                  {isPty && (
                    <button
                      className={`${styles.tab} ${activeTab === 'terminal' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('terminal')}
                    >
                      Terminal
                      <span className={styles.tabPtyBadge}>PTY</span>
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
                                  expandedThinking,
                                  setExpandedThinking,
                                  expandedArgs,
                                  setExpandedArgs,
                                  selectedSession.ideName,
                                  selectedSession.state,
                                )}
                              </div>
                            ) : (
                              <div className={styles.messageBox}>{selectedSession.lastMessage}</div>
                            )}
                          </section>
                        )}
                      </div>
                      {selectedSession.state !== 'closed' && (() => {
                        const activeSubagents = selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking');
                        const isDone = selectedSession.state === 'waiting' && selectedSession.completionHint === 'done';
                        const needsApproval = selectedSession.needsPermission === true;
                        const stateLabel = isDone ? 'Task complete'
                          : needsApproval ? 'Waiting for approval'
                          : selectedSession.state === 'waiting' && activeSubagents.length > 0 ? 'Delegated · waiting for subagent'
                          : selectedSession.state === 'waiting' ? 'Waiting for your response'
                          : selectedSession.state === 'thinking' ? 'Thinking...'
                          : 'Working...';
                        const stateClass = isDone ? styles.stateBarDone
                          : needsApproval ? styles.stateBarPermission
                          : selectedSession.state === 'waiting' ? styles.stateBarWaiting
                          : selectedSession.state === 'thinking' ? styles.stateBarThinking
                          : styles.stateBarActive;
                        return (
                          <>
                            <div className={`${styles.stateBar} ${stateClass}`}>
                              <span className={styles.stateBarDot} />
                              <span className={styles.stateBarLabel}>{stateLabel}</span>
                              {activeSubagents.length > 0 && (
                                <span className={styles.stateBarDelegate}>
                                  · {activeSubagents.length} delegated
                                </span>
                              )}
                              <div style={{flex: 1}} />
                              {(selectedSession.state === 'thinking' || selectedSession.state === 'working') && elapsedSeconds > 2 && (
                                <span className={styles.stateBarElapsed}>{formatElapsed(elapsedSeconds)}</span>
                              )}
                              {isDone && !selectedSession.userAccepted && onAcceptSession && (
                                <button
                                  className={styles.acceptBtn}
                                  onClick={() => onAcceptSession(selectedSession.sessionId)}
                                  title="Accept this completed session"
                                >
                                  Accept
                                </button>
                              )}
                              {isDone && selectedSession.userAccepted && (
                                <span className={styles.acceptedLabel}>Accepted ✓</span>
                              )}
                            </div>
                            {needsApproval && (
                              <PermissionPrompt
                                sessionId={selectedSession.sessionId}
                                promptText={selectedSession.permissionPromptText}
                                styles={styles}
                              />
                            )}
                          </>
                        );
                      })()}
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
                                if (!connected) return;
                                const text = sendInput2.trim();
                                if (!text && !pastedImage) {
                                  // bare Enter — send \r to confirm a prompt (e.g. permission dialog)
                                  injectText(selectedSession.sessionId, '', false);
                                  return;
                                }
                                const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
                                injectText(selectedSession.sessionId, full, !!pastedImage);
                                if (full) setLocalSent(prev => [...prev, full]);
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

                {/* Tab: Terminal */}
                {activeTab === 'terminal' && isPty && (
                  <div className={styles.terminalContent}>
                    <XtermTerminal
                      sessionId={selectedSession.sessionId}
                      onInput={(data) => sendInput(selectedSession.sessionId, data)}
                      onResize={(cols, rows) => resizePty(selectedSession.sessionId, cols, rows)}
                      registerOutputHandler={registerOutputHandler}
                      isExited={isExited}
                      fillHeight
                    />
                  </div>
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
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>Launched from</span>
                        <span className={selectedSession.launchMethod === 'overlord-pty' ? styles.overlordPill : styles.fieldValue}>
                          {selectedSession.launchMethod === 'ide'
                            ? (selectedSession.ideName
                                ? selectedSession.ideName.replace(/^(.)/, c => c.toUpperCase())
                                : 'IDE')
                            : selectedSession.launchMethod === 'overlord-pty'
                            ? '↺ Overlord (internal)'
                            : 'Terminal'}
                        </span>
                      </div>
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

                      {/* Dormitory button */}
                      {onToggleDormitory && (
                        <div className={styles.dormitoryRow}>
                          <button
                            className={`${styles.dormitoryBtn} ${isInDormitory?.(selectedSession.sessionId) ? styles.dormitoryBtnActive : ''}`}
                            onClick={() => onToggleDormitory(selectedSession.sessionId)}
                          >
                            {isInDormitory?.(selectedSession.sessionId) ? '↑ Bring back from dormitory' : '↓ Put to dormitory'}
                          </button>
                        </div>
                      )}

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

                      {/* Resume section — only when closed */}
                      {selectedSession.state === 'closed' && (
                        <div className={styles.resumeSection}>
                          <div className={styles.resumeSectionLabel}>Resume</div>
                          <div className={styles.resumeCommand}>
                            <code>claude --resume {selectedSession.sessionId}</code>
                          </div>
                          <div className={styles.resumeButtons}>
                            {onResumeSession && (
                              <button
                                className={styles.resumeButton}
                                onClick={() => onResumeSession(selectedSession.sessionId, selectedSession.cwd)}
                              >
                                Resume in Overlord
                              </button>
                            )}
                            <button
                              className={styles.copyResumeButton}
                              onClick={() => {
                                navigator.clipboard.writeText(`claude --resume ${selectedSession.sessionId}`);
                                setCopyConfirm(true);
                                setTimeout(() => setCopyConfirm(false), 2000);
                              }}
                            >
                              {copyConfirm ? 'Copied!' : 'Copy resume command'}
                            </button>
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
