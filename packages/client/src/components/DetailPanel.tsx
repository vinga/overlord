import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTick } from '../hooks/useTick';
import type { Session, WorkerState, ActivityItem, PendingQuestionSet } from '../types';
import { getLaunchInfo } from '../types';
import { XtermTerminal } from './XtermTerminal';
import { WorkerAvatar } from './WorkerAvatar';
import { Worker } from './Worker';
import { ConsolePreview } from './ConsolePreview';
import styles from './DetailPanel.module.css';
import { SessionCommands } from './SessionCommands';
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

/** Renders user message content, replacing @<path> image references with clickable thumbnails */
function UserMessageContent({ content, styles, expandedImages, onToggleImage }: {
  content: string;
  styles: Record<string, string>;
  expandedImages: Set<number>;
  onToggleImage: (idx: number) => void;
}) {
  // Split content on @<path-to-overlord-paste-image> patterns
  const imagePattern = /@((?:[A-Za-z]:\\|\/)[^\s]+overlord-paste-[^\s]+\.(?:png|jpg|jpeg))/gi;
  const parts: Array<{ type: 'text'; value: string } | { type: 'image'; path: string; idx: number }> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let imgIdx = 0;
  while ((match = imagePattern.exec(content)) !== null) {
    if (match.index > last) parts.push({ type: 'text', value: content.slice(last, match.index) });
    parts.push({ type: 'image', path: match[1], idx: imgIdx++ });
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push({ type: 'text', value: content.slice(last) });

  // If no images found, fall back to regular markdown
  if (parts.length === 1 && parts[0].type === 'text') {
    return <div className={styles.markdownContent} dangerouslySetInnerHTML={{ __html: renderMarkdown(content.trimEnd()) }} />;
  }

  return (
    <div className={styles.markdownContent}>
      {parts.map((p, i) => {
        if (p.type === 'text') {
          return <span key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(p.value.trimEnd()) }} />;
        }
        const isExpanded = expandedImages.has(p.idx);
        const src = `/api/paste-image?path=${encodeURIComponent(p.path)}`;
        return (
          <span key={i} className={styles.inlineImageBlock}>
            <code className={styles.inlineImagePath} title="Click to copy path" onClick={() => { navigator.clipboard.writeText(p.path); }}>@{p.path}</code>
            <button
              className={styles.inlineImageToggle}
              onClick={() => onToggleImage(p.idx)}
              title={isExpanded ? 'Hide image' : 'Show image'}
            >
              {isExpanded ? '▾ hide' : '▸ preview'}
            </button>
            {isExpanded && (
              <img src={src} alt="pasted" className={styles.inlineImage} />
            )}
          </span>
        );
      })}
    </div>
  );
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
  onOpenBridged?: (sessionId: string, cwd: string) => void;
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
  isBridgeSession?: (sessionId: string) => boolean;
  pty: PtyHandlers;
  actions: SessionActions;

  siblingActiveSessions?: Session[];
  onSelectSession?: (session: Session) => void;
  customNames?: Record<string, string>;
  panelWidth: number;
  onPanelWidthChange?: (width: number) => void;
  bridgePath?: string;
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
          {error ? 'Failed' : '1. Yes'}
        </button>
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnAlways}`}
          onClick={() => void respond('\x1b[B\r')}
          disabled={responding}
        >
          2. Yes, allow this session
        </button>
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnNo}`}
          onClick={() => void respond('\x1b')}
          disabled={responding}
        >
          3. No
        </button>
      </div>
    </div>
  );
}

function QuestionPrompt({ sessionId, questionSet, initialStage, onStageChange, styles }: {
  sessionId: string;
  questionSet: PendingQuestionSet;
  initialStage: number;
  onStageChange: (stage: number) => void;
  styles: Record<string, string>;
}) {
  const [stage, setStage] = React.useState(initialStage);
  const [responding, setResponding] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);

  const questions = questionSet.questions ?? [];
  if (questions.length === 0) return null;
  const question = questions[stage];
  if (!question) return null;
  const total = questions.length;

  // AskUserQuestion TUI uses arrow-key navigation.
  // We send arrows first, wait for the TUI to process them, then send Enter.
  const doInject = async (text: string, raw = false) => {
    const r = await fetch(`/api/sessions/${sessionId}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, raw }),
    });
    if (!r.ok) throw new Error(`inject failed: ${r.status}`);
  };

  const respond = async (optionIndex: number, label: string) => {
    setResponding(true);
    setSelected(label);
    setError(false);
    try {
      // Send each arrow individually (raw=true so no auto-appended \r), then Enter
      for (let i = 0; i < optionIndex; i++) {
        await doInject('\x1b[B', true);
        await new Promise(r => setTimeout(r, 80));
      }
      await doInject('\r');
      if (stage < total - 1) {
        // Advance to next question after a brief pause
        setTimeout(() => {
          const next = stage + 1;
          setStage(next);
          onStageChange(next);
          setSelected(null);
          setResponding(false);
        }, 400);
      } else {
        // Last question answered — TUI shows a "Review + Submit" confirmation step.
        // Auto-confirm by sending Enter (selects "Submit answers", option 1) after a delay.
        setTimeout(() => void doInject('\r').catch(() => null), 600);
        // Clear persisted stage so next question set starts at 0
        onStageChange(0);
        // Leave responding=true until transcript clears the prompt
      }
    } catch {
      setError(true);
      setSelected(null);
      setResponding(false);
      setTimeout(() => setError(false), 3000);
    }
  };

  return (
    <div className={styles.questionPrompt}>
      <div className={styles.questionMeta}>
        {question.header && <span className={styles.questionHeader}>{question.header}</span>}
        {total > 1 && (
          <span className={styles.questionProgress}>{stage + 1} / {total}</span>
        )}
      </div>
      <div className={styles.questionText}>{question.question}</div>
      {question.options.length > 0 ? (
        <div className={styles.questionOptions}>
          {question.options.map((opt, i) => (
            <button
              key={i}
              className={`${styles.questionOption} ${selected === opt.label ? styles.questionOptionSelected : ''} ${error ? styles.questionOptionError : ''}`}
              onClick={() => void respond(i, opt.label)}
              disabled={responding}
            >
              <span className={styles.questionOptionNum}>{i + 1}</span>
              <span className={styles.questionOptionBody}>
                <span className={styles.questionOptionLabel}>{opt.label}</span>
                {opt.description && <span className={styles.questionOptionDesc}>{opt.description}</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.questionPromptActions}>
          <button className={`${styles.permissionBtn} ${styles.permissionBtnYes}`} onClick={() => void respond(0, 'Continue')} disabled={responding}>
            {error ? 'Failed' : 'Continue'}
          </button>
        </div>
      )}
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
  | { type: 'thinking'; item: ActivityItem }
  | { type: 'compact'; item: ActivityItem };

function buildSegments(feed: ActivityItem[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  for (const item of feed) {
    if (item.kind === 'compact') {
      segments.push({ type: 'compact', item });
    } else if (item.kind === 'tool') {
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
        {showRunning && sessionState === 'working' && tool.durationMs === undefined && (
          <span className={styles.toolRunningSpinner} />
        )}
        {showDuration && tool.durationMs !== undefined && (
          <span className={styles.toolDuration} title="Duration">
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 2, verticalAlign: -0.5 }}>
              <path d="M6.5.5a.5.5 0 00 0 1h3a.5.5 0 000-1zM8 3a6 6 0 100 12A6 6 0 008 3zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM8.25 5a.75.75 0 00-1.5 0v3.5c0 .414.336.75.75.75H10a.75.75 0 000-1.5H8.25z"/>
            </svg>
            took {tool.durationMs < 100 ? '<0.1' : (tool.durationMs / 1000).toFixed(1)}<span style={{ opacity: 0.6 }}>s</span>
          </span>
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
  // Keyed by message content so state survives UserMessageContent remounts
  const [expandedImagesMap, setExpandedImagesMap] = useState<Map<string, Set<number>>>(new Map());
  const toggleImage = useCallback((contentKey: string, idx: number) => {
    setExpandedImagesMap(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(contentKey) ?? []);
      if (set.has(idx)) set.delete(idx); else set.add(idx);
      next.set(contentKey, set);
      return next;
    });
  }, []);

  return (
    <>
      {segments.map((seg, segIdx) => {
        if (seg.type === 'compact') {
          const meta = seg.item.compactMeta;
          const tokens = meta?.preTokens ? meta.preTokens.toLocaleString() : null;
          return (
            <div key={segIdx} className={styles.compactDivider}>
              <span className={styles.compactDividerLabel}>
                ✦ Compacted{meta?.trigger === 'manual' ? ' (manual)' : ''}{tokens ? ` · ${tokens} tokens` : ''}
              </span>
            </div>
          );
        }
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
                    ) : seg.item.role === 'user' ? (
                      <UserMessageContent
                        content={seg.item.content}
                        styles={styles}
                        expandedImages={expandedImagesMap.get(seg.item.content ?? '') ?? new Set()}
                        onToggleImage={(idx) => toggleImage(seg.item.content ?? '', idx)}
                      />
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
        // Show the last tool's description as a hint (active tool or last completed)
        const lastTool = seg.items[seg.items.length - 1];
        const activeDesc = lastTool?.content || undefined;
        const groupTotalMs = seg.items.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
        const hasGroupDuration = seg.items.some(t => t.durationMs !== undefined);
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
              {isLastSegment && sessionState === 'working' && lastTool?.durationMs === undefined && (
                <span className={styles.toolRunningSpinner} />
              )}
              <span className={`${styles.toolDesc} ${isLastSegment ? '' : styles.toolDescHoverOnly}`} style={{ marginLeft: 4 }}>
                {lastTool?.toolName}{activeDesc ? `: ${activeDesc.length > 50 ? activeDesc.slice(0, 50) + '…' : activeDesc}` : ''}
              </span>
              {hasGroupDuration && (
                <span className={`${styles.toolDuration} ${styles.toolDescHoverOnly}`} title="Total duration">
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 2, verticalAlign: -0.5 }}>
                    <path d="M6.5.5a.5.5 0 00 0 1h3a.5.5 0 000-1zM8 3a6 6 0 100 12A6 6 0 008 3zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM8.25 5a.75.75 0 00-1.5 0v3.5c0 .414.336.75.75.75H10a.75.75 0 000-1.5H8.25z"/>
                  </svg>
                  took {groupTotalMs < 100 ? '<0.1' : (groupTotalMs / 1000).toFixed(1)}<span style={{ opacity: 0.6 }}>s</span>
                </span>
              )}
              <span className={styles.toolGroupCount}>{seg.items.length}</span>
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
                  showRunning={true}
                  showDuration={true}
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
  selectedSessionId,
  selectedSubagentId,
  customName,
  onRename,
  onClose,
  connected,
  isPtySession,
  isBridgeSession,
  pty,
  actions,

  siblingActiveSessions,
  onSelectSession,
  customNames,
  panelWidth,
  onPanelWidthChange,
  bridgePath,
}: DetailPanelProps) {
  const { sendInput, injectText, resizePty, registerOutputHandler, exitedSessions, getError } = pty;
  const { onDeleteSession, onResumeSession, onOpenInTerminal, onOpenBridged, onMarkDone, onAcceptSession, onAcceptTask } = actions;
  // Panel is "open" if we have a session OR a pending PTY session ID
  const effectiveSessionId = selectedSession?.sessionId ?? selectedSessionId;
  const isPendingPty = !selectedSession && !!effectiveSessionId && isPtySession(effectiveSessionId);
  const isOpen = selectedSession !== null || isPendingPty;

  // Re-render every second to update duration / relative times — only when panel is open
  useTick(selectedSession ? 1000 : null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Persist question stage across remounts (snapshot refreshes can unmount/remount QuestionPrompt)
  const questionStageRef = useRef<Map<string, number>>(new Map());

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
  const draftPerSession = useRef<Map<string, string>>(new Map());
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  const [showConvoResumePrompt, setShowConvoResumePrompt] = useState(false);
  const [pastedImage, setPastedImage] = useState<{ path: string; previewUrl: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyIdConfirm, setCopyIdConfirm] = useState(false);
  const [killing, setKilling] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [openingBridged, setOpeningBridged] = useState(false);
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
    // Save current draft before switching
    const prevId = prevSessionIdRef.current;
    if (prevId && sendInput2.trim()) {
      draftPerSession.current.set(prevId, sendInput2);
    } else if (prevId) {
      draftPerSession.current.delete(prevId);
    }
    prevSessionIdRef.current = selectedSession?.sessionId;

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
    // Restore draft for the new session
    setSendInput2(selectedSession?.sessionId ? (draftPerSession.current.get(selectedSession.sessionId) ?? '') : '');
    setConfirmDelete(false);
    setPastedImage(null);
    setKilling(false);
    setConfirmKill(false);
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
    // During compaction, preserve the draft — injection will be queued but may be swallowed
    if (selectedSession.isCompacting) return;
    const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
    injectText(selectedSession.sessionId, full, true);
    if (full) {
      // Snapshot real user message count on first pending send
      if (realCountAtFirstSend.current === null) {
        const feed = selectedSession.activityFeed ?? [];
        realCountAtFirstSend.current = feed.filter(i => i.role === 'user').length;
      }
      setLocalSent(prev => [...prev, full]);
    }
    setSendInput2('');
    if (selectedSession) draftPerSession.current.delete(selectedSession.sessionId);
    setPastedImage(null);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't close on Escape — panel should stay open
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const isPty = selectedSession ? isPtySession(selectedSession.sessionId) : false;
  const isExited = selectedSession ? exitedSessions.has(selectedSession.sessionId) : false;
  const sessionError = selectedSession ? getError(selectedSession.sessionId) : undefined;


  // Clear stale pending messages after 15s (safety net — content de-duplication handles normal flow)
  useEffect(() => {
    if (localSent.length === 0) return;
    const timer = setTimeout(() => setLocalSent([]), 15_000);
    return () => clearTimeout(timer);
  }, [localSent]);

  // Also clear pending when session transitions to 'working' or 'thinking' —
  // that means the server received the message and Claude started processing it.
  // This handles the case where the message text never appears in the feed
  // (e.g. injected before the feed is populated) but injection clearly succeeded.
  const prevSessionStateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentState = selectedSession?.state;
    const prevState = prevSessionStateRef.current;
    prevSessionStateRef.current = currentState;
    if (
      localSent.length > 0 &&
      (currentState === 'working' || currentState === 'thinking') &&
      prevState === 'waiting'
    ) {
      // Session transitioned from waiting → working/thinking: injection was received
      setLocalSent([]);
      realCountAtFirstSend.current = null;
    }
  }, [selectedSession?.state, localSent.length]);

  // Build merged activityFeed: real feed + optimistic locally-sent messages
  // Content-based: pending messages stay until their content appears in the real feed
  const realFeed = selectedSession?.activityFeed ?? [];
  const realUserContents = new Set(
    realFeed.filter(i => i.role === 'user').map(i => i.content?.slice(0, 200))
  );
  const dedupedPending = localSent.filter(t => !realUserContents.has(t.slice(0, 200)));
  // Once all locally-sent messages are confirmed, reset tracking
  if (dedupedPending.length === 0 && localSent.length > 0) {
    queueMicrotask(() => {
      setLocalSent([]);
      realCountAtFirstSend.current = null;
    });
  }
  const mergedFeed: ActivityItem[] = [
    ...realFeed,
    ...dedupedPending.map(t => ({ kind: 'message' as const, role: 'user' as const, content: t.slice(0, 200), pending: true })),
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
  const stateBarHasQuestion = !stateBarNeedsApproval && !!selectedSession?.pendingQuestion;
  const isCompacting = selectedSession?.isCompacting === true;
  const stateBarLabel = isCompacting ? 'Compacting conversation…'
    : stateBarIsDone ? 'Task complete'
    : stateBarNeedsApproval ? 'Waiting for approval'
    : stateBarHasQuestion ? 'Question for you'
    : selectedSession?.state === 'waiting' && stateBarActiveSubagents.length > 0 ? 'Delegated · waiting for subagent'
    : selectedSession?.state === 'waiting' ? 'Waiting for your response'
    : selectedSession?.state === 'thinking' ? 'Thinking...'
    : 'Working...';
  const stateBarClass = isCompacting ? styles.stateBarCompacting
    : stateBarIsDone ? styles.stateBarDone
    : stateBarNeedsApproval ? styles.stateBarPermission
    : stateBarHasQuestion ? styles.stateBarQuestion
    : selectedSession?.state === 'waiting' ? styles.stateBarWaiting
    : selectedSession?.state === 'thinking' ? styles.stateBarThinking
    : styles.stateBarActive;

  return (
    <>
      {/* Panel */}
      <div
        className={`${styles.panel} ${styles.panelOpen}`}
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        style={{ width: panelWidth }}
      >
        <div className={styles.resizeHandle} onMouseDown={onResizeMouseDown} />
        {!selectedSession && !isPendingPty && (
          <div className={styles.emptyPanel}>
            <div className={styles.emptyPanelIcon}>👁</div>
            <div className={styles.emptyPanelTitle}>No session selected</div>
            <div className={styles.emptyPanelHint}>Click on a worker to view its conversation, tasks, and terminal</div>
          </div>
        )}
        {isPendingPty && effectiveSessionId && (
          <>
            <div className={styles.colorStrip} style={{ background: '#d4af37' }} />
            <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">&times;</button>
            <div className={styles.panelHeader}>
              <div className={styles.headerMain}>
                <h2 className={styles.sessionName}>Starting session...</h2>
                <div className={styles.summaryRow}>
                  <span style={{ color: '#888', fontSize: 13 }}>Waiting for Claude to initialize</span>
                </div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <XtermTerminal
                sessionId={effectiveSessionId}
                onInput={(data) => sendInput(effectiveSessionId, data)}
                onResize={(cols, rows) => resizePty(effectiveSessionId, cols, rows)}
                registerOutputHandler={registerOutputHandler}
                fillHeight
              />
            </div>
          </>
        )}
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
                          onClick={() => navigator.clipboard.writeText(`name: ${currentDisplayName} id: ${selectedSession.sessionId}`)}
                          title={`Copy name + ID`}
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
                    {(() => { const l = getLaunchInfo(selectedSession, isPty); return (
                      <span className={styles.launchBadge} data-category={l.category} data-tooltip={`Launch: ${l.name}`}>{l.name}</span>
                    ); })()}
                    {selectedSession.permissionMode && (
                      <span
                        className={`${styles.permissionModeBadge} ${styles.permissionModeBadgeClickable}`}
                        data-mode={selectedSession.permissionMode}
                        data-tooltip={
                          selectedSession.permissionMode === 'bypassPermissions' ? 'Bypass all permissions — click to change' :
                          selectedSession.permissionMode === 'acceptEdits' ? 'Auto-accept edits — click to change' :
                          selectedSession.permissionMode === 'plan' ? 'Plan mode only — click to change' :
                          'Default permissions — click to change'
                        }
                        role="button"
                        tabIndex={0}
                        onClick={async () => {
                          try {
                            await fetch(`/api/sessions/${selectedSession.sessionId}/cycle-permission-mode`, {
                              method: 'POST',
                            });
                          } catch { /* ignore */ }
                        }}
                      >
                        {selectedSession.permissionMode === 'bypassPermissions' ? 'bypass' :
                         selectedSession.permissionMode === 'acceptEdits' ? 'auto-edit' :
                         selectedSession.permissionMode === 'plan' ? 'plan' :
                         'default'}
                      </span>
                    )}
                    <span className={`${styles.summaryMeta} ${styles.summaryMetaAgo}`} data-tooltip={`Last activity: ${new Date(selectedSession.lastActivity).toLocaleString()}`}>{formatRelativeTime(selectedSession.lastActivity)}</span>
                    {selectedSession.model && <span className={styles.summaryMeta} data-tooltip={`Model: ${selectedSession.model}`}>{selectedSession.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>}
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
                  {(isPty || selectedSession.sessionType === 'embedded') && (
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
                        sessionType={selectedSession.sessionType}
                      />
                      {selectedSession && selectedSession.state !== 'closed' && !selectedSession.userAccepted && (
                        <>
                          <div className={`${styles.stateBar} ${stateBarClass}`}>
                            <span className={styles.stateBarDot} />
                            <span className={styles.stateBarLabel}>{stateBarLabel}</span>
                            {elapsedSeconds > 2 && (
                              <span className={styles.stateBarElapsed}>{formatElapsed(elapsedSeconds)}</span>
                            )}
                            {stateBarActiveSubagents.length > 0 && (
                              <span className={styles.stateBarDelegate}>
                                · {stateBarActiveSubagents.length} delegated
                              </span>
                            )}
                            <div style={{flex: 1}} />
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
                            {(selectedSession.state === 'working' || selectedSession.state === 'thinking') && (
                              <>
                                <button
                                  className={styles.interruptBtnSmall}
                                  data-tooltip="Interrupt (Esc)"
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
                                  ■
                                </button>
                                <button
                                  className={styles.forceStopBtnSmall}
                                  data-tooltip="Force Stop (Ctrl+C)"
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
                                  ✕
                                </button>
                              </>
                            )}
                          </div>
                          {stateBarNeedsApproval && (
                            <PermissionPrompt
                              sessionId={selectedSession.sessionId}
                              promptText={selectedSession.permissionPromptText}
                              styles={styles}
                            />
                          )}
                          {!stateBarNeedsApproval && selectedSession.pendingQuestion && (
                            <QuestionPrompt
                              key={selectedSession.sessionId + '-q'}
                              sessionId={selectedSession.sessionId}
                              questionSet={selectedSession.pendingQuestion}
                              initialStage={questionStageRef.current.get(selectedSession.sessionId) ?? 0}
                              onStageChange={(s) => { questionStageRef.current.set(selectedSession.sessionId, s); }}
                              styles={styles}
                            />
                          )}
                        </>
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
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                setSendInput2('');
                              } else if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (!connected) return;
                                const text = sendInput2.trim();
                                if (!text && !pastedImage) {
                                  // bare Enter — send \r to confirm a prompt (e.g. permission dialog)
                                  injectText(selectedSession.sessionId, '\r', false);
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
                {activeTab === 'terminal' && (isPty || selectedSession.sessionType === 'embedded') && (
                  isPty ? (
                    <div className={styles.terminalContent}>
                      <XtermTerminal
                        sessionId={selectedSession.sessionId}
                        onInput={(data) => sendInput(selectedSession.sessionId, data)}
                        onResize={(cols, rows) => resizePty(selectedSession.sessionId, cols, rows)}
                        registerOutputHandler={registerOutputHandler}
                        isExited={isExited && !isPty}
                        onResume={
                          onResumeSession
                            ? () => onResumeSession(selectedSession.sessionId, selectedSession.cwd)
                            : undefined
                        }
                        fillHeight
                        fixedSize={isBridgeSession?.(selectedSession.sessionId) ? { cols: 120, rows: 30 } : undefined}
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
                          <SessionCommands
                            cwd={selectedSession.cwd}
                            name={currentDisplayName}
                            sessionId={selectedSession.sessionId}
                            bridgePath={bridgePath}
                          />
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
                            {onOpenBridged && (
                              <button
                                className={`${styles.resumeButton} ${openingBridged ? styles.resumeButtonPending : ''}`}
                                disabled={openingBridged}
                                onClick={() => {
                                  setOpeningBridged(true);
                                  onOpenBridged(selectedSession.sessionId, selectedSession.cwd);
                                  setTimeout(() => setOpeningBridged(false), 3000);
                                }}
                              >
                                {openingBridged ? 'Opening…' : 'Open Bridged'}
                              </button>
                            )}
                            {selectedSession.state !== 'closed' && (
                              confirmKill ? (
                                <div className={styles.killConfirmInline}>
                                  <span>Kill session?</span>
                                  <button
                                    className={styles.killConfirmYes}
                                    onClick={() => {
                                      setConfirmKill(false);
                                      setKilling(true);
                                      fetch(`/api/sessions/${selectedSession.sessionId}/kill-process`, { method: 'POST' })
                                        .catch(console.error)
                                        .finally(() => setKilling(false));
                                    }}
                                  >
                                    Kill
                                  </button>
                                  <button className={styles.killConfirmNo} onClick={() => setConfirmKill(false)}>Cancel</button>
                                </div>
                              ) : (
                                <button
                                  className={`${styles.resumeButton} ${styles.killSessionButton} ${killing ? styles.resumeButtonPending : ''}`}
                                  disabled={killing}
                                  onClick={() => setConfirmKill(true)}
                                >
                                  {killing ? 'Killing…' : 'Kill Session'}
                                </button>
                              )
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
