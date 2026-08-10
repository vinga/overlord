import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTick } from '../hooks/useTick';
import { updateNoteFirstLine } from '../hooks/useNotesSummaries';
import { useRoomPrefix, selectAfterPrefix } from '../hooks/useRoomPrefix';
import { loadDraft, saveDraft, clearDraft, migrateDraftKey } from '../hooks/draftStore';
import { loadSentHistory, pushSentHistory, type SentEntry } from '../hooks/sentHistoryStore';
import { useToolTextPrefs, toggleBreakNewlines, toggleWrap, unescapeToolText } from '../hooks/useToolTextPrefs';
import type { Session, WorkerState, ActivityItem, Subagent, PendingQuestionSet, SessionReview } from '../types';
import { getLaunchInfo } from '../types';
import { PARK_REASON_MAX } from '../lib/review';
import { XtermTerminal } from './XtermTerminal';
import { WorkerAvatar } from './WorkerAvatar';
import { ColorPicker } from './ColorPicker';
import { Worker } from './Worker';
import { ConsolePreview } from './ConsolePreview';
import styles from './DetailPanel.module.css';
import { SessionCommands } from './SessionCommands';
import { searchFeed, BoldExcerpt } from '../lib/search';
import { FileEditorOverlay } from './FileEditorOverlay';
import { DiffViewer } from './DiffViewer';
import { SelectionMenu } from './SelectionMenu';
import { QUICK_PROMPTS } from './quickPrompts';
import { SkillPickerPopup } from './SkillPickerPopup';
import { SkillChips } from './SkillChips';
import { JiraChips } from './JiraChips';
import { PrChips } from './PrChips';
import { useJiraBaseUrl } from '../hooks/useJiraBaseUrl';
import { ArtifactsTab } from './ArtifactsTab';
import { QuestionPrompt } from './QuestionPrompt';
import { ScheduledWakeupsStats } from './ScheduledWakeupsStats';
import { useTranscriptScroll } from '../hooks/useTranscriptScroll';
import {
  setJiraProjectAllowlist,
  hasJiraAllowlist,
  urlTicketKey,
  prUrlRef,
  collectInlineMatches,
  splitPathLine,
} from '../lib/jiraInline';
import { useStickyUserMessage, type StickyUserMessage } from '../hooks/useStickyUserMessage';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

// Open all links in new tab
marked.use({
  hooks: {
    postprocess(html: string) {
      return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    },
  },
});

const MARKDOWN_CACHE_MAX = 500;
const markdownCache = new Map<string, string>();

/** Feed the inline-ticket matcher from settings. markdownCache is keyed by text
 *  alone, so HTML rendered under the previous allowlist has to go. */
export function setJiraProjects(raw: string | undefined) {
  if (setJiraProjectAllowlist(raw)) markdownCache.clear();
}

/** `+` affordance appended to a ticket or PR token; the delegated click handler
 *  in DetailPanel turns it into a POST. */
function makeAddButton(doc: Document, cls: string, label: string): HTMLButtonElement {
  const add = doc.createElement('button');
  add.className = cls;
  add.setAttribute('tabindex', '-1');
  add.setAttribute('title', label);
  add.setAttribute('aria-label', label);
  add.textContent = '+';
  return add;
}

const makeJiraAddButton = (doc: Document, key: string) =>
  makeAddButton(doc, 'jiraAddBtn', `Add ${key} to this session's tickets`);

const makePrAddButton = (doc: Document, ref: string) =>
  makeAddButton(doc, 'prAddBtn', `Add ${ref} to this session's pull requests`);

/** Exported for tests: turns rendered markdown HTML into the feed's final HTML —
 *  fence action bars, file-path spans, ticket and PR tokens with their `+`. */
export function linkifyPaths(html: string, wrapFences = true): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild as HTMLElement | null;
  if (!root) return html;
  // Wrap every fenced block with a hover action bar: a copy-to-clipboard button
  // for all of them, plus a "render" toggle on ```markdown / ```md fences so
  // their content can be shown as real formatted markdown instead of grey source.
  if (wrapFences) {
    root.querySelectorAll('pre').forEach((el) => {
      const pre = el as HTMLElement;
      const parent = pre.parentElement;
      if (!parent || parent.classList.contains('codeBlock')) return;
      const code = pre.querySelector('code');
      const isMarkdown = !!code && /(^|\s)language-(markdown|md)(\s|$)/.test(code.className);
      const wrapper = doc.createElement('div');
      wrapper.className = isMarkdown ? 'codeBlock mdFence' : 'codeBlock';
      const actions = doc.createElement('div');
      actions.className = 'codeBlockActions';
      if (isMarkdown) {
        wrapper.setAttribute('data-md-src', encodeURIComponent(code!.textContent ?? ''));
        const btn = doc.createElement('button');
        btn.className = 'mdFenceToggle';
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-state', 'source');
        btn.textContent = 'render';
        actions.appendChild(btn);
      }
      const copy = doc.createElement('button');
      copy.className = 'codeCopyBtn';
      copy.setAttribute('type', 'button');
      copy.setAttribute('title', 'Copy to clipboard');
      copy.setAttribute('aria-label', 'Copy code block to clipboard');
      copy.textContent = 'copy';
      actions.appendChild(copy);
      parent.replaceChild(wrapper, pre);
      wrapper.appendChild(actions);
      wrapper.appendChild(pre);
    });
  }
  // Ticket URLs are already anchors by the time we get here (marked autolinks
  // them), and the walker below skips anchor text — so pin them in place: keep
  // the link, hang a `+` off it. Anchors inside code fences are left alone.
  root.querySelectorAll('a[href]').forEach((a) => {
    if (a.closest('pre, code')) return;
    const href = a.getAttribute('href') ?? '';
    // PRs first: a PR URL often carries a ticket key in its branch segment, but
    // it is a PR link — the `+` must pin the PR, not the ticket.
    const prRef = prUrlRef(href);
    if (prRef) {
      if (a.querySelector('.prAddBtn')) return;
      a.setAttribute('data-pr-ref', prRef);
      a.className = `${a.className} inlinePrRef`.trim();
      a.appendChild(makePrAddButton(doc, prRef));
      return;
    }
    if (!hasJiraAllowlist()) return;
    const key = urlTicketKey(href);
    if (!key || a.querySelector('.jiraAddBtn')) return;
    a.setAttribute('data-jira-key', key);
    a.className = `${a.className} inlineJiraKey`.trim();
    a.appendChild(makeJiraAddButton(doc, key));
  });
  // Code contexts are walked too — paths in backticks are the most common
  // presentation — but only `path` matches are wrapped there, in a span that
  // stays visually silent until hover. Jira tokens (and their `+` buttons)
  // never enter code. Span wrapping keeps `textContent` byte-identical, so
  // copy-paste and the mdFence render toggle are unaffected.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (p.tagName === 'A') return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? '';
    const inCode = tn.parentElement?.closest('pre, code') != null;
    let matches = collectInlineMatches(text);
    if (inCode) matches = matches.filter((m) => m.kind === 'path');
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const match of matches) {
      if (match.index > last) frag.appendChild(doc.createTextNode(text.slice(last, match.index)));
      const span = doc.createElement('span');
      if (match.kind === 'path') {
        const { path, line } = splitPathLine(match.text);
        span.setAttribute('data-file-path', path);
        if (line !== undefined) span.setAttribute('data-file-line', String(line));
        span.className = inCode ? 'inlineFilePathCode' : 'inlineFilePath';
        span.textContent = match.text;
      } else if (match.kind === 'pr') {
        const ref = match.key ?? match.text;
        span.setAttribute('data-pr-ref', ref);
        span.className = 'inlinePrRef';
        span.appendChild(doc.createTextNode(match.text));
        span.appendChild(makePrAddButton(doc, ref));
      } else {
        const key = match.key ?? match.text;
        span.setAttribute('data-jira-key', key);
        span.className = 'inlineJiraKey';
        span.appendChild(doc.createTextNode(match.text));
        span.appendChild(makeJiraAddButton(doc, key));
      }
      frag.appendChild(span);
      last = match.index + match.text.length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }
  return root.innerHTML;
}
function renderMarkdown(text: string, wrapFences = true): string {
  const cacheKey = wrapFences ? text : `@nofence@${text}`;
  const cached = markdownCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = linkifyPaths(marked.parse(text) as string, wrapFences);
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    markdownCache.delete(markdownCache.keys().next().value!);
  }
  markdownCache.set(cacheKey, result);
  return result;
}

function formatModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function getContextWindow(model: string | undefined, inputTokens: number | undefined): number {
  // Haiku family is 200k. Opus/Sonnet 4.x support a 1M context beta; if observed
  // tokens exceed 200k we know the session is on 1M, otherwise assume 200k.
  if (model && /haiku/i.test(model)) return 200_000;
  if (inputTokens !== undefined && inputTokens > 200_000) return 1_000_000;
  return 200_000;
}

function getFirstLineInfo(content: string): { index: number; text: string } {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) return { index: i, text: lines[i] };
  }
  return { index: 0, text: '' };
}

function renderWithLinks(text: string, linkClass: string): React.ReactNode[] {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <a
        key={key++}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        onClick={(e) => e.stopPropagation()}
      >
        {match[0]}
      </a>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function assistantLabel(provider?: Session['provider']): string {
  if (provider === 'codex') return 'codex';
  if (provider === 'opencode') return 'opencode';
  return 'claude';
}

function assistantDisplayName(provider?: Session['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

function assistantPillClass(provider: Session['provider'] | undefined, styles: Record<string, string>): string {
  if (provider === 'codex') return styles.assistantPillCodex;
  if (provider === 'opencode') return styles.assistantPillOpencode;
  return styles.assistantPillClaude;
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

/** Scrollable container that only captures wheel events after being clicked */
function ScrollOnClick({ className, children }: { className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!activeRef.current) {
        e.preventDefault();
        let parent = el.parentElement;
        while (parent) {
          const ov = getComputedStyle(parent).overflowY;
          if (ov === 'auto' || ov === 'scroll') { parent.scrollBy({ top: e.deltaY }); break; }
          parent = parent.parentElement;
        }
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    if (!active) return;
    const out = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setActive(false);
    };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [active]);

  return (
    <div
      ref={ref}
      className={className}
      onClick={() => setActive(true)}
      style={active ? { outline: '1px solid rgba(212,175,55,0.35)', outlineOffset: '-1px' } : { cursor: 'text' }}
    >
      {children}
    </div>
  );
}

interface PtyHandlers {
  sendInput: (sessionId: string, data: string) => void;
  injectText: (sessionId: string, text: string, extraEnter?: boolean) => boolean;
  resizePty: (sessionId: string, cols: number, rows: number) => void;
  registerOutputHandler: (sessionId: string, handler: (data: Uint8Array) => void) => (() => void);
  exitedSessions: Set<string>;
  getError: (sessionId: string) => string | undefined;
}

interface SessionActions {
  onDeleteSession?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string, cwd: string) => void;
  onResumeArchived?: (sessionId: string, cwd: string) => void;
  onCloneArchived?: (sessionId: string, cwd: string) => void;
  onCloneSession?: (sessionId: string) => void;
  onDeleteArchived?: (sessionId: string) => void;
  onOpenInTerminal?: (sessionId: string, cwd: string) => void;
  onOpenBridged?: (sessionId: string, cwd: string) => void;
  onFocusBridge?: (sessionId: string) => void;
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
  onSelectSession?: (session: Session, subagentId?: string, timestamp?: string, query?: string) => void;
  customNames?: Record<string, string>;
  panelWidth: number;
  onPanelWidthChange?: (width: number) => void;
  bridgePath?: string;
  platform?: string;
  /** Timestamp of an ActivityItem to scroll to (from search) */
  scrollTarget?: string;
  /** Query that was searched — used to highlight matching text within the target item */
  scrollQuery?: string;
  onScrollTargetConsumed?: () => void;
  /** Room breadcrumb navigation. `open` = also toggle the room detail panel. */
  onNavigateRoom?: (cwd: string, open: boolean) => void;
  /** Global setting: pin the governing user message atop the Conversation feed. */
  showStickyUserMessage?: boolean;
}

function isFilePath(s: string): boolean {
  return /^([A-Za-z]:[/\\]|\/[^\s])/.test(s);
}

/**
 * Walk text nodes inside `root` and wrap the first case-insensitive
 * occurrence of `query` in a <span data-search-wrap="1">. Returns the
 * wrapping span, or null if no match was found / match spans multiple
 * text nodes. The wrap is temporary — caller is responsible for unwrapping.
 */
function highlightMatchingText(root: HTMLElement, query: string): HTMLElement | null {
  if (!query) return null;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip script/style and empty text
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? '';
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + query.length);
    const span = document.createElement('span');
    span.dataset.searchWrap = '1';
    try {
      range.surroundContents(span);
    } catch {
      return null;
    }
    return span;
  }
  return null;
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

/** "4h ago" for the parked banner. Epoch-ms twin of formatRelativeTime. */
function formatParkedAge(parkedAt: number): string {
  const mins = Math.floor((Date.now() - parkedAt) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

function PermissionPrompt({ sessionId, promptText, isLimitPrompt, styles }: {
  sessionId: string;
  promptText?: string;
  isLimitPrompt?: boolean;
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

  // Keyboard shortcuts: 1/2/3 for permission options, Enter/x for limit prompt
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (responding) return;
      // Don't fire if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (isLimitPrompt) {
        if (e.key === 'Enter') { e.preventDefault(); void respond('\r'); }
        else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); void respond('\x03'); }
      } else {
        if (e.key === '1') { e.preventDefault(); void respond('\r'); }
        else if (e.key === '2') { e.preventDefault(); void respond('\x1b[B\r'); }
        else if (e.key === '3') { e.preventDefault(); void respond('\x1b'); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [responding, isLimitPrompt, sessionId]);

  return (
    <div className={styles.permissionPrompt}>
      {promptText && (
        <pre className={styles.permissionPromptText}>{promptText}</pre>
      )}
      <div className={styles.permissionPromptActions}>
        {isLimitPrompt ? (
          <>
            <button
              className={`${styles.permissionBtn} ${styles.permissionBtnYes}`}
              onClick={() => void respond('\r')}
              disabled={responding}
            >
              {error ? 'Failed' : 'Continue'}
            </button>
            <button
              className={`${styles.permissionBtn} ${styles.permissionBtnNo}`}
              onClick={() => void respond('\x03')}
              disabled={responding}
            >
              Exit
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
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

interface StateBadgeProps {
  state: WorkerState;
  activeSubagentCount?: number;
  review?: SessionReview;
  parkReason?: string;
  /** Absent ⇒ the badge is read-only (archived session). */
  onSetReview?: (review: SessionReview | null, reason?: string) => void;
}

/**
 * The state pill, doubling as the review menu.
 *
 * 'read' is a waiting-only silencer, so it's offered only while waiting. Park is
 * offered in any non-closed state — setting aside a session that is still
 * grinding is a legitimate "I'm done looking at this for now".
 */
function StateBadge({ state, activeSubagentCount, review, parkReason, onSetReview }: StateBadgeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [parking, setParking] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => { setMenuOpen(false); setParking(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const isParked = review === 'parked';
  const isReadWaiting = state === 'waiting' && review === 'read';
  const color = isParked ? '#64748b' : isReadWaiting ? '#94a3b8' : STATE_COLORS[state];
  const label = isParked ? 'parked' : isReadWaiting ? 'read' : state;

  const canReview = state !== 'closed' && !!onSetReview;
  const canMarkRead = state === 'waiting' && !isParked;

  const commit = (next: SessionReview | null, why?: string) => {
    onSetReview?.(next, why);
    setParking(false);
    setMenuOpen(false);
  };

  return (
    <>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span
          className={styles.stateBadge}
          style={{ background: color, color: '#1a1a2e', cursor: canReview ? 'pointer' : undefined }}
          onClick={canReview ? () => setMenuOpen(v => !v) : undefined}
          title={isParked && parkReason ? `Parked · ${parkReason}` : undefined}
        >
          {label}
        </span>
        {menuOpen && canReview && (
          <div className={styles.badgeReviewMenu} onMouseDown={e => e.stopPropagation()}>
            {parking ? (
              <div className={styles.badgeParkForm}>
                <input
                  className={styles.badgeParkInput}
                  autoFocus
                  maxLength={PARK_REASON_MAX}
                  placeholder="why parked? (optional)"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); commit('parked', reason); }
                    if (e.key === 'Escape') { e.preventDefault(); setParking(false); }
                  }}
                />
                <button className={styles.badgeReviewBtn} onClick={() => commit('parked', reason)}>
                  ⏸ Park
                </button>
              </div>
            ) : (
              <>
                {canMarkRead && (
                  <button
                    className={styles.badgeReviewBtn}
                    onClick={() => commit(review === 'read' ? null : 'read')}
                  >
                    {review === 'read' ? '↺ Un-read' : '✓ Read'}
                  </button>
                )}
                {!isParked && (
                  <button
                    className={styles.badgeReviewBtn}
                    onClick={() => { setReason(''); setParking(true); }}
                  >
                    ⏸ Park…
                  </button>
                )}
                {isParked && (
                  <>
                    <button
                      className={styles.badgeReviewBtn}
                      onClick={() => { setReason(parkReason ?? ''); setParking(true); }}
                    >
                      ✎ Edit reason
                    </button>
                    <button className={styles.badgeReviewBtn} onClick={() => commit(null)}>
                      ↺ Un-park
                    </button>
                  </>
                )}
              </>
            )}
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
  | { type: 'question'; item: ActivityItem }
  | { type: 'compact'; item: ActivityItem }
  | { type: 'recap'; item: ActivityItem };

function buildSegments(feed: ActivityItem[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  for (const item of feed) {
    if (item.kind === 'compact') {
      segments.push({ type: 'compact', item });
    } else if (item.kind === 'recap') {
      segments.push({ type: 'recap', item });
    } else if (item.kind === 'tool' && item.toolName === 'AskUserQuestion') {
      // AskUserQuestion is rendered as its own prominent Q&A block, never grouped
      segments.push({ type: 'question', item });
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

// AskUserQuestion tool_result looks like: Your questions have been answered: "Q"="A". ...
// Pull out the chosen answer label(s) so we can show them next to the question.
function parseQuestionAnswers(resultJson?: string): string[] {
  if (!resultJson) return [];
  const out: string[] = [];
  const re = /"[^"]*"\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(resultJson)) !== null) out.push(m[1]);
  return out;
}

interface ParsedQuestionOption { label: string; description?: string }
interface ParsedQuestion { question: string; header?: string; options: ParsedQuestionOption[] }

// Parse the full question(s) + all options from the tool input JSON (best-effort;
// strings are truncated server-side to ~500 chars).
function parseQuestionInput(inputJson?: string): ParsedQuestion[] {
  if (!inputJson) return [];
  try {
    const parsed = JSON.parse(inputJson) as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }> }> };
    return (parsed.questions ?? [])
      .filter(q => q.question)
      .map(q => ({
        question: q.question!,
        header: q.header,
        options: (q.options ?? []).map(o => ({ label: o.label ?? '', description: o.description })).filter(o => o.label),
      }));
  } catch {
    return [];
  }
}

// Build the PendingQuestionSet shape QuestionPrompt expects from the tool input JSON.
function questionInputToSet(inputJson?: string): PendingQuestionSet | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as { kind?: 'ask' | 'system'; questions?: Array<{ question?: string; header?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string; preview?: string; builtin?: boolean }> }> };
    const questions = (parsed.questions ?? [])
      .filter(q => q.question)
      .map(q => ({
        question: q.question!,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: (q.options ?? []).map(o => ({ label: o.label ?? '', description: o.description, preview: o.preview, builtin: o.builtin })).filter(o => o.label),
      }));
    // `kind` rides through the same JSON so a CLI modal keeps its answering rules
    // after the round-trip; anything but 'system' is the ordinary tool menu.
    return questions.length > 0 ? { questions, ...(parsed.kind === 'system' ? { kind: 'system' as const } : {}) } : null;
  } catch {
    return null;
  }
}

// Renders an AskUserQuestion entry inline in the conversation as a Q&A block,
// with the full question + every option, chosen highlighted, expandable.
function QuestionEntry({ item, styles, stale }: { item: ActivityItem; styles: Record<string, string>; stale?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const answers = parseQuestionAnswers(item.resultJson);
  const parsed = parseQuestionInput(item.inputJson);
  // Fallback to the flat content/answers when input JSON is unavailable.
  const questions: ParsedQuestion[] = parsed.length > 0
    ? parsed
    : (item.content?.trim() ? item.content.trim().split(' · ').map(q => ({ question: q, options: [] })) : []);
  // Skip the streaming artifact: an AskUserQuestion tool_use with no question and no answer.
  if (questions.length === 0 && answers.length === 0) return null;
  const pending = answers.length === 0;
  // A tool_result with no parseable answer is a decline (Esc, or "Type something" /
  // "Chat about this") — not a question still waiting on the user.
  const declined = pending && !!item.resultJson;
  const hasOptions = questions.some(q => q.options.length > 0);
  return (
    <div className={styles.qaEntry}>
      <div className={styles.qaLabel}>
        <span className={styles.qaIcon}>?</span>
        Question{questions.length > 1 ? 's' : ''}
        {pending && (
          <span className={styles.qaPending} title={(stale || declined) ? 'The terminal is no longer showing this menu — answer in the message box instead.' : undefined}>
            {declined ? 'declined' : stale ? 'no longer on screen' : 'awaiting answer'}
          </span>
        )}
        {hasOptions && (
          <button className={styles.qaToggle} onClick={() => setExpanded(e => !e)}>
            {expanded ? 'hide options' : 'show options'}
          </button>
        )}
      </div>
      {questions.length > 0 ? questions.map((q, i) => {
        const chosen = answers[i];
        return (
          <div key={i} className={styles.qaRow}>
            {q.header && <div className={styles.qaHeader}>{q.header}</div>}
            <div className={styles.qaQuestion}>{q.question}</div>
            {expanded && q.options.length > 0 ? (
              <div className={styles.qaOptions}>
                {q.options.map((opt, oi) => {
                  const isChosen = chosen != null && opt.label === chosen;
                  return (
                    <div key={oi} className={`${styles.qaOption} ${isChosen ? styles.qaOptionChosen : ''}`}>
                      <span className={styles.qaOptionMark}>{isChosen ? '✓' : ''}</span>
                      <span className={styles.qaOptionBody}>
                        <span className={styles.qaOptionLabel}>{opt.label}</span>
                        {opt.description && <span className={styles.qaOptionDesc}>{opt.description}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              chosen && <div className={styles.qaAnswer}>{chosen}</div>
            )}
          </div>
        );
      }) : answers.map((a, i) => (
        <div key={i} className={styles.qaRow}><div className={styles.qaAnswer}>{a}</div></div>
      ))}
    </div>
  );
}

function parseTaskNotification(content: string): { summary: string; status: string } | null {
  if (!content.trimStart().startsWith('<task-notification>')) return null;
  const summary = content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'Task completed';
  const status = content.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? 'completed';
  return { summary, status };
}

interface ToolEntryProps {
  tool: { toolName?: string; content?: string; inputJson?: string; resultJson?: string; isError?: boolean; durationMs?: number; oldString?: string; newString?: string; oldStringTruncated?: boolean; newStringTruncated?: boolean; timestamp?: string };
  diffKey: string;
  argsKey: string;
  resultKey: string;
  expandedDiffs: Set<string>;
  setExpandedDiffs: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedArgs: Set<string>;
  setExpandedArgs: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedResults: Set<string>;
  setExpandedResults: React.Dispatch<React.SetStateAction<Set<string>>>;
  ideName?: string;
  showRunning?: boolean;
  showDuration?: boolean;
  sessionState?: string;
  styles: Record<string, string>;
  cwd?: string;
  onAgentClick?: () => void;
  subagentType?: string;
  isInlineExpanded?: boolean;
  onToggleInline?: () => void;
}

function ToolEntry({
  tool,
  diffKey,
  argsKey,
  resultKey,
  expandedDiffs,
  setExpandedDiffs,
  expandedArgs,
  setExpandedArgs,
  expandedResults,
  setExpandedResults,
  ideName,
  showRunning,
  showDuration,
  sessionState,
  styles,
  cwd,
  onAgentClick,
  subagentType,
  isInlineExpanded,
  onToggleInline,
}: ToolEntryProps) {
  const hasDiff = (tool.toolName === 'Edit' || tool.toolName === 'Write') && tool.newString !== undefined;
  const isDiffExpanded = expandedDiffs.has(diffKey);
  const isArgsExpanded = expandedArgs.has(argsKey);
  const isResultExpanded = expandedResults.has(resultKey);
  const skillName = tool.toolName === 'Skill' && tool.inputJson
    ? (() => { try { return (JSON.parse(tool.inputJson) as { skill?: string }).skill ?? null; } catch { return null; } })()
    : null;
  const { breakNewlines, wrap } = useToolTextPrefs();
  const argsText = useMemo(
    () => (isArgsExpanded && breakNewlines && tool.inputJson) ? unescapeToolText(tool.inputJson) : tool.inputJson,
    [tool.inputJson, breakNewlines, isArgsExpanded],
  );
  const resultText = useMemo(
    () => (isResultExpanded && breakNewlines && tool.resultJson) ? unescapeToolText(tool.resultJson) : tool.resultJson,
    [tool.resultJson, breakNewlines, isResultExpanded],
  );
  const showTextToggles = (isArgsExpanded && tool.inputJson) || (isResultExpanded && tool.resultJson);
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
        {tool.resultJson && (
          <button
            className={`${styles.diffToggle} ${tool.isError ? styles.resultToggleError : styles.resultToggle}`}
            onClick={() => setExpandedResults(prev => {
              const next = new Set(prev);
              if (next.has(resultKey)) next.delete(resultKey); else next.add(resultKey);
              return next;
            })}
          >
            {tool.isError ? 'error' : 'result'}
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
        {onAgentClick && (
          <button
            className={styles.agentViewLink}
            onClick={(e) => { e.stopPropagation(); onAgentClick(); }}
            title="Open subagent detail"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 3, verticalAlign: -1 }}>
              <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 5.5a.5.5 0 01-1 0v-.5A2.5 2.5 0 009.5 10.5h-3A2.5 2.5 0 004 13v.5a.5.5 0 01-1 0V13a3.5 3.5 0 013.5-3.5h3A3.5 3.5 0 0113 13v.5z"/>
            </svg>
            {subagentType && subagentType !== 'unknown' ? subagentType : 'view agent'}
          </button>
        )}
        {onToggleInline && (
          <button
            className={styles.agentInlineToggle}
            onClick={(e) => { e.stopPropagation(); onToggleInline(); }}
            title={isInlineExpanded ? 'Collapse subagent conversation' : 'Expand subagent conversation'}
          >
            {isInlineExpanded ? '▾' : '▸'}
          </button>
        )}
        {tool.content && (
          isFilePath(tool.content)
            ? <button className={styles.toolDescLink} title={tool.content} onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('overlord:openFile', { detail: { path: tool.content } })); }}>{trimPath(tool.content, cwd)}</button>
            : <span className={styles.toolDesc}>{tool.content}</span>
        )}
        {skillName && <span className={styles.toolDesc}>{skillName}</span>}
      </div>
      {showTextToggles && (
        <div className={styles.argsViewToggles}>
          <button
            className={`${styles.argsViewToggle} ${breakNewlines ? styles.argsViewToggleActive : ''}`}
            title="Render escaped \n and \t as real line breaks"
            onClick={(e) => { e.stopPropagation(); toggleBreakNewlines(); }}
          >
            \n
          </button>
          <button
            className={`${styles.argsViewToggle} ${wrap ? styles.argsViewToggleActive : ''}`}
            title="Soft-wrap long lines"
            onClick={(e) => { e.stopPropagation(); toggleWrap(); }}
          >
            wrap
          </button>
        </div>
      )}
      {isArgsExpanded && argsText && (
        <pre className={`${styles.argsView} ${wrap ? styles.argsViewWrap : ''}`}>{argsText}</pre>
      )}
      {isResultExpanded && resultText && (
        <pre className={`${styles.argsView} ${wrap ? styles.argsViewWrap : ''} ${tool.isError ? styles.resultViewError : styles.resultView}`}>{resultText}</pre>
      )}
      {hasDiff && isDiffExpanded && (
        <DiffViewer
          oldString={tool.oldString ?? ''}
          newString={tool.newString ?? ''}
          oldStringTruncated={tool.oldStringTruncated}
          newStringTruncated={tool.newStringTruncated}
          // For Edit/Write the tool description IS the absolute file path.
          filePath={tool.content && isFilePath(tool.content) ? tool.content : undefined}
          editedAt={tool.timestamp}
          wrap={wrap}
        />
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
  subagents?: Subagent[];
  onSelectSubagent?: (agentId: string) => void;
  scrollTargetTs?: string;
  // When set, a pending (unanswered) AskUserQuestion in the feed renders as an
  // interactive prompt that injects the choice into this session's TUI.
  questionSessionId?: string;
  questionStageRef?: React.MutableRefObject<Map<string, number>>;
  onQuestionDismissedToChat?: () => void;
  /** Server says the live screen has no AskUserQuestion menu — the pending question
   *  in the transcript can no longer be answered by injecting keystrokes. */
  questionStale?: boolean;
  /** Tag user messages so useStickyUserMessage can pin them. Only the two
   *  top-level feeds set this — inline subagent feeds nest inside the same
   *  scroll container and their prompts aren't the user's. */
  markUserMessages?: boolean;
}

/** User-role transcript entries the harness generates on your behalf — command
 *  echoes, compact continuations, hook output. They read as "user" in the JSONL
 *  but pinning one as "what you asked" would be a lie. */
const SYNTHETIC_USER_PREFIXES = [
  '<environment_details',
  '<local-command',
  '<command-name>',
  '<bash-input>',
  '<bash-stdout>',
  '<system-reminder',
  '<user-prompt-submit-hook',
  'Caveat: The messages below',
  'This session is being continued from a previous conversation',
  'Continue from where you left off.',
];

function isSyntheticUserContent(content: string): boolean {
  const head = content.trimStart();
  return SYNTHETIC_USER_PREFIXES.some(p => head.startsWith(p));
}

/** DOM markers for the pinned-message header. Returns undefined for entries
 *  that aren't things the user typed (skill preambles, empty/system content). */
function userMsgAttrs(item: ActivityItem, segIdx: number, isSkillDef: boolean): Record<string, string> | undefined {
  if (item.role !== 'user' || isSkillDef) return undefined;
  if (!item.content || isSyntheticUserContent(item.content)) return undefined;
  const firstLine = item.content.split('\n').find(l => l.trim().length > 0)?.trim();
  if (!firstLine) return undefined;
  return {
    'data-user-msg': item.timestamp ?? `seg:${segIdx}`,
    'data-user-text': firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine,
  };
}

function FeedSegments({ feed, roleLabel, ideName, sessionState, styles, isPty, cwd, subagents, onSelectSubagent, scrollTargetTs, questionSessionId, questionStageRef, onQuestionDismissedToChat, questionStale, markUserMessages }: FeedSegmentsProps) {
  const segments = useMemo(() => buildSegments(feed), [feed]);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<number>>(new Set());

  // Auto-expand any multi-tool group that contains the scroll target so its
  // children are in the DOM and the scroll handler can find them.
  useEffect(() => {
    if (!scrollTargetTs) return;
    const toExpand: number[] = [];
    segments.forEach((seg, idx) => {
      if (seg.type === 'toolGroup' && seg.items.length > 1 &&
          seg.items.some(t => t.timestamp === scrollTargetTs)) {
        toExpand.push(idx);
      }
    });
    if (toExpand.length === 0) return;
    setExpandedToolGroups(prev => {
      const next = new Set(prev);
      for (const idx of toExpand) next.add(idx);
      return next;
    });
  }, [scrollTargetTs, segments]);
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const [rawSegments, setRawSegments] = useState<Set<number>>(new Set());
  const [copiedBubble, setCopiedBubble] = useState<number | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [expandedInlineAgents, setExpandedInlineAgents] = useState<Set<number>>(new Set());
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
        if (seg.type === 'question') {
          // Pending (unanswered, live in the TUI) → interactive prompt that injects
          // the choice. Answered, or stale (TUI no longer on the menu) → read-only.
          const isPending = !seg.item.resultJson;
          const qSet = isPending && !questionStale ? questionInputToSet(seg.item.inputJson) : null;
          if (isPending && qSet && questionSessionId && questionStageRef) {
            return (
              <div key={segIdx} data-ts={seg.item.timestamp} style={{ display: 'contents' }}>
                <QuestionPrompt
                  key={questionSessionId + '-q'}
                  sessionId={questionSessionId}
                  questionSet={qSet}
                  initialStage={questionStageRef.current.get(questionSessionId) ?? 0}
                  onStageChange={(s) => { questionStageRef.current.set(questionSessionId, s); }}
                  onDismissedToChat={onQuestionDismissedToChat}
                  styles={styles}
                />
              </div>
            );
          }
          return <div key={segIdx} data-ts={seg.item.timestamp} style={{ display: 'contents' }}><QuestionEntry item={seg.item} styles={styles} stale={isPending && questionStale} /></div>;
        }
        if (seg.type === 'compact') {
          const meta = seg.item.compactMeta;
          const tokens = meta?.preTokens ? meta.preTokens.toLocaleString() : null;
          // For PTY-sourced items, extract the parenthesized info from content (e.g. "2m 1s · ↑ 698 tokens")
          const ptyMeta = !meta && seg.item.content
            ? seg.item.content.match(/\(([^)]+)\)/)?.[1] ?? null
            : null;
          return (
            <div key={segIdx} className={styles.compactDivider} data-ts={seg.item.timestamp}>
              <span className={styles.compactDividerLabel}>
                ✦ Compacted{meta?.trigger === 'manual' ? ' (manual)' : ''}{tokens ? ` · ${tokens} tokens` : ''}{ptyMeta ? ` · ${ptyMeta}` : ''}
              </span>
            </div>
          );
        }
        if (seg.type === 'recap') {
          return (
            <div key={segIdx} className={styles.recapBlock} data-ts={seg.item.timestamp}>
              <span className={styles.recapLabel}>✳ recap</span>
              <span className={styles.recapText}>{seg.item.content}</span>
            </div>
          );
        }
        if (seg.type === 'thinking') {
          const isExpanded = expandedThinking.has(segIdx);
          if (seg.item.isRedacted) {
            return (
              <div key={segIdx} className={styles.thinkingBlock} data-ts={seg.item.timestamp}>
                <span className={styles.thinkingRedacted}>🔒 Thinking redacted</span>
              </div>
            );
          }
          return (
            <div key={segIdx} className={styles.thinkingBlock} data-ts={seg.item.timestamp}>
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
          const prevSeg = segIdx > 0 ? segments[segIdx - 1] : null;
          const isAfterTools = seg.item.role === 'user' && prevSeg?.type === 'toolGroup';
          const isSkillDef = seg.item.role === 'user' && seg.item.content?.startsWith('Base directory for this skill');
          return (
            <div
              key={segIdx}
              data-ts={seg.item.timestamp}
              {...(markUserMessages ? userMsgAttrs(seg.item, segIdx, isSkillDef) : undefined)}
              className={`${styles.transcriptEntry} ${styles[`role_${seg.item.role}`]} ${seg.item.pending ? styles.pendingMessage : ''}`}
            >
              {seg.item.pending && <span className={styles.pendingBadge}>queued</span>}
              {isSkillDef ? (
                <ScrollOnClick className={`${styles.transcriptBubble} ${styles.transcriptBubbleSkillDef}`}>
                  <UserMessageContent
                    content={seg.item.content}
                    styles={styles}
                    expandedImages={expandedImagesMap.get(seg.item.content ?? '') ?? new Set()}
                    onToggleImage={(idx) => toggleImage(seg.item.content ?? '', idx)}
                  />
                  {seg.item.timestamp && (
                    <span className={`${styles.feedTimestamp} ${styles.feedTimestampUser}`}>
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 3, verticalAlign: -1 }}>
                        <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 3a.75.75 0 01.75.75v3.69l2.28 2.28a.75.75 0 01-1.06 1.06l-2.5-2.5A.75.75 0 017.25 8V3.75A.75.75 0 018 3z"/>
                      </svg>
                      {formatFeedTimestamp(seg.item.timestamp)}
                    </span>
                  )}
                </ScrollOnClick>
              ) : (
              <div className={`${styles.transcriptBubble} ${isAfterTools ? styles.transcriptBubbleCompact : ''}`}>
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
                    {seg.item.contentTruncated && (
                      <div className={styles.truncatedNotice}>
                        message truncated — open the terminal for the full text
                      </div>
                    )}
                    <button
                      className={`${styles.rawToggle} ${styles.copyBubbleBtn}`}
                      onClick={() => {
                        navigator.clipboard.writeText(seg.item.content ?? '');
                        setCopiedBubble(segIdx);
                        setTimeout(() => setCopiedBubble(null), 1500);
                      }}
                      title="Copy message"
                    >
                      {copiedBubble === segIdx ? (
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
                      )}
                    </button>
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
              )}
            </div>
          );
        }
        // Single-tool group — show inline, no toggle
        if (seg.items.length === 1) {
          const tool = seg.items[0];
          const diffKey = `${segIdx}-0`;
          const argsKey = `${segIdx}-0-args`;
          const resultKey = `${segIdx}-0-result`;
          const isLastSegment = segIdx === segments.length - 1;
          // For Agent tool calls, resolve matching subagent by description
          let agentClickHandler: (() => void) | undefined;
          let matchedSubagentType: string | undefined;
          let matchedSubagent: Subagent | undefined;
          if (tool.toolName === 'Agent' && subagents && tool.inputJson) {
            try {
              const parsed = JSON.parse(tool.inputJson) as { description?: string };
              const desc = parsed.description;
              if (desc) {
                const match = subagents.find(s => s.description === desc);
                if (match) {
                  matchedSubagent = match;
                  matchedSubagentType = match.agentType;
                  if (onSelectSubagent) agentClickHandler = () => onSelectSubagent(match.agentId);
                }
              }
            } catch { /* ignore parse errors */ }
          }
          const isInlineExpanded = expandedInlineAgents.has(segIdx);
          const toggleInline = matchedSubagent ? () => setExpandedInlineAgents(prev => {
            const next = new Set(prev);
            if (next.has(segIdx)) next.delete(segIdx); else next.add(segIdx);
            return next;
          }) : undefined;
          return (
            <div key={segIdx} data-ts={tool.timestamp} style={{ display: 'contents' }}>
              <ToolEntry
                tool={tool}
                diffKey={diffKey}
                argsKey={argsKey}
                resultKey={resultKey}
                expandedDiffs={expandedDiffs}
                setExpandedDiffs={setExpandedDiffs}
                expandedArgs={expandedArgs}
                setExpandedArgs={setExpandedArgs}
                expandedResults={expandedResults}
                setExpandedResults={setExpandedResults}
                ideName={ideName}
                showRunning={isLastSegment}
                showDuration={true}
                sessionState={sessionState}
                styles={styles}
                cwd={cwd}
                onAgentClick={agentClickHandler}
                subagentType={matchedSubagentType}
                isInlineExpanded={matchedSubagent ? isInlineExpanded : undefined}
                onToggleInline={toggleInline}
              />
              {matchedSubagent && isInlineExpanded && (
                <div className={styles.inlineAgentFeed}>
                  {matchedSubagent.activityFeed?.length ? (
                    <FeedSegments
                      feed={matchedSubagent.activityFeed}
                      roleLabel={roleLabel}
                      styles={styles}
                      sessionState={matchedSubagent.state}
                    />
                  ) : (
                    <span className={styles.inlineAgentEmpty}>No activity yet</span>
                  )}
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
        // Show the last tool's description as a hint (active tool or last completed)
        const lastTool = seg.items[seg.items.length - 1];
        const activeDesc = lastTool?.content || undefined;
        const groupTotalMs = seg.items.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
        const hasGroupDuration = seg.items.some(t => t.durationMs !== undefined);
        return (
          <div
            key={segIdx}
            className={styles.toolGroup}
            data-ts={seg.items[0]?.timestamp}
            data-ts-list={seg.items.map(t => t.timestamp).filter(Boolean).join(' ')}
          >
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
                {lastTool?.toolName}{activeDesc ? `: ${(trimPath(activeDesc, cwd)).length > 50 ? trimPath(activeDesc, cwd).slice(0, 50) + '…' : trimPath(activeDesc, cwd)}` : ''}
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
              const resultKey = `${segIdx}-${ti}-result`;
              // Resolve agent-specific props for Agent tool entries inside multi-tool groups
              let agentClickHandler: (() => void) | undefined;
              let matchedSubagentType: string | undefined;
              let matchedSubagent: Subagent | undefined;
              if (tool.toolName === 'Agent' && subagents && tool.inputJson) {
                try {
                  const parsed = JSON.parse(tool.inputJson) as { description?: string };
                  const desc = parsed.description;
                  if (desc) {
                    const match = subagents.find(s => s.description === desc);
                    if (match) {
                      matchedSubagent = match;
                      matchedSubagentType = match.agentType;
                      if (onSelectSubagent) agentClickHandler = () => onSelectSubagent(match.agentId);
                    }
                  }
                } catch { /* ignore */ }
              }
              const inlineKey = segIdx * 1000 + ti;
              const isInlineExpanded = expandedInlineAgents.has(inlineKey);
              const toggleInline = matchedSubagent ? () => setExpandedInlineAgents(prev => {
                const next = new Set(prev);
                if (next.has(inlineKey)) next.delete(inlineKey); else next.add(inlineKey);
                return next;
              }) : undefined;
              return (
                <div key={ti} data-ts={tool.timestamp} style={{ display: 'contents' }}>
                  <ToolEntry
                    tool={tool}
                    diffKey={diffKey}
                    argsKey={argsKey}
                    resultKey={resultKey}
                    expandedDiffs={expandedDiffs}
                    setExpandedDiffs={setExpandedDiffs}
                    expandedArgs={expandedArgs}
                    setExpandedArgs={setExpandedArgs}
                    expandedResults={expandedResults}
                    setExpandedResults={setExpandedResults}
                    ideName={ideName}
                    showRunning={true}
                    showDuration={true}
                    sessionState={sessionState}
                    styles={styles}
                    cwd={cwd}
                    onAgentClick={agentClickHandler}
                    subagentType={matchedSubagentType}
                    isInlineExpanded={matchedSubagent ? isInlineExpanded : undefined}
                    onToggleInline={toggleInline}
                  />
                  {matchedSubagent && isInlineExpanded && (
                    <div className={styles.inlineAgentFeed}>
                      {matchedSubagent.activityFeed?.length ? (
                        <FeedSegments
                          feed={matchedSubagent.activityFeed}
                          roleLabel={roleLabel}
                          styles={styles}
                          sessionState={matchedSubagent.state}
                        />
                      ) : (
                        <span className={styles.inlineAgentEmpty}>No activity yet</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

type JumpBtnInfo = { label: string; depth: number } | null;

interface ScrollJumpNavProps {
  up: JumpBtnInfo;
  down: JumpBtnInfo;
  onUp: () => void;
  onDown: () => void;
  styles: Record<string, string>;
}

function ScrollJumpNav({ up, down, onUp, onDown, styles }: ScrollJumpNavProps) {
  const visible = up !== null || down !== null;
  return (
    <div
      className={`${styles.scrollJumpNav} ${visible ? styles.scrollJumpNavVisible : ''}`}
      aria-hidden={!visible}
    >
      <button
        type="button"
        className={styles.scrollJumpBtn}
        onClick={onUp}
        disabled={up === null}
        title={up?.label ?? ''}
        aria-label={up?.label ?? 'Scroll up'}
        tabIndex={visible && up ? 0 : -1}
      >
        <span className={styles.scrollJumpBtnArrow} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 7.5L6 4.5L9 7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={styles.scrollJumpBtnDots} aria-hidden="true">
          {up ? Array.from({ length: up.depth }).map((_, i) => (
            <span key={i} className={styles.scrollJumpBtnDot} />
          )) : null}
        </span>
      </button>
      <button
        type="button"
        className={styles.scrollJumpBtn}
        onClick={onDown}
        disabled={down === null}
        title={down?.label ?? ''}
        aria-label={down?.label ?? 'Scroll down'}
        tabIndex={visible && down ? 0 : -1}
      >
        <span className={styles.scrollJumpBtnArrow} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={styles.scrollJumpBtnDots} aria-hidden="true">
          {down ? Array.from({ length: down.depth }).map((_, i) => (
            <span key={i} className={styles.scrollJumpBtnDot} />
          )) : null}
        </span>
      </button>
    </div>
  );
}

interface StickyUserHeaderProps {
  sticky: StickyUserMessage | null;
  /** Matches the feed's own role label — "you" in a session, "parent" in a subagent feed. */
  label: string;
  onPrev: () => void;
  onNext: () => void;
  styles: Record<string, string>;
}

/** One-line pin of the user message governing the visible stretch of the feed.
 *  Renders nothing while that message is still on screen. The arrows walk the
 *  feed message by message: up lands on the pinned one, down on the one after. */
function StickyUserHeader({ sticky, label, onPrev, onNext, styles }: StickyUserHeaderProps) {
  if (!sticky) return null;
  const hasNext = sticky.hasNext;
  return (
    <div className={styles.stickyUserHeader}>
      <button
        type="button"
        className={styles.stickyUserHeaderMain}
        onClick={onPrev}
        title={`${sticky.text}\n\nClick to scroll back to this message`}
      >
        <span className={styles.stickyUserHeaderLabel}>{label}</span>
        <span className={styles.stickyUserHeaderText}>{sticky.text}</span>
      </button>
      <span className={styles.stickyUserHeaderNav}>
        <button
          type="button"
          className={styles.stickyUserHeaderNavBtn}
          onClick={onPrev}
          title="Previous message"
          aria-label="Scroll to previous message"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 7.5L6 4.5L9 7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.stickyUserHeaderNavBtn}
          onClick={onNext}
          disabled={!hasNext}
          title={hasNext ? 'Next message' : 'No later message'}
          aria-label="Scroll to next message"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
    </div>
  );
}

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
  platform = 'darwin',
  scrollTarget,
  scrollQuery,
  onScrollTargetConsumed,
  onNavigateRoom,
  showStickyUserMessage = true,
}: DetailPanelProps) {
  const { sendInput, injectText, resizePty, registerOutputHandler, exitedSessions, getError } = pty;
  const { onDeleteSession, onResumeSession, onResumeArchived, onCloneArchived, onCloneSession, onDeleteArchived, onOpenInTerminal, onOpenBridged, onFocusBridge } = actions;
  // Panel is "open" if we have a session OR a pending PTY session ID
  const effectiveSessionId = selectedSession?.sessionId ?? selectedSessionId;
  // selectedSessionId is now an ovrId — use it directly for PTY routing.
  // Fall back to overlordId from session (for legacy UUID-keyed hashes), then effectiveSessionId.
  const effectiveOvrId = selectedSessionId ?? selectedSession?.overlordId ?? effectiveSessionId ?? '';
  const isPendingPty = !selectedSession && !!effectiveSessionId && isPtySession(effectiveSessionId);
  const isOpen = selectedSession !== null || isPendingPty;

  // Re-render every second to update duration / relative times — only when panel is open
  useTick(selectedSession ? 1000 : null);

  const jiraBaseUrl = useJiraBaseUrl();

  const [fileEditorTarget, setFileEditorTarget] = useState<{ path: string; line?: number } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; line?: number }>).detail;
      if (detail?.path) setFileEditorTarget({ path: detail.path, line: detail.line });
    };
    const clickHandler = (e: MouseEvent) => {
      const copyBtn = (e.target as HTMLElement | null)?.closest('.codeCopyBtn') as HTMLElement | null;
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const wrapper = copyBtn.closest('.codeBlock') as HTMLElement | null;
        const pre = wrapper?.querySelector('pre') as HTMLElement | null;
        // Path/Jira spans keep textContent byte-identical, so this is the raw source.
        const text = (pre?.querySelector('code') ?? pre)?.textContent ?? '';
        if (!text) return;
        const flash = (label: string) => {
          copyBtn.textContent = label;
          copyBtn.classList.add('codeCopyBtnDone');
          window.setTimeout(() => {
            copyBtn.textContent = 'copy';
            copyBtn.classList.remove('codeCopyBtnDone');
          }, 1200);
        };
        navigator.clipboard.writeText(text).then(() => flash('copied'), () => flash('failed'));
        return;
      }
      const fenceToggle = (e.target as HTMLElement | null)?.closest('.mdFenceToggle') as HTMLElement | null;
      if (fenceToggle) {
        e.preventDefault();
        const wrapper = fenceToggle.closest('.mdFence') as HTMLElement | null;
        const pre = wrapper?.querySelector('pre') as HTMLElement | null;
        if (!wrapper || !pre) return;
        if (fenceToggle.getAttribute('data-state') === 'source') {
          const src = decodeURIComponent(wrapper.getAttribute('data-md-src') ?? '');
          let rendered = wrapper.querySelector('.mdFenceRendered') as HTMLElement | null;
          if (!rendered) {
            rendered = document.createElement('div');
            rendered.className = `mdFenceRendered ${styles.markdownContent}`;
            rendered.innerHTML = renderMarkdown(src, false);
            wrapper.appendChild(rendered);
          } else {
            rendered.style.display = '';
          }
          pre.style.display = 'none';
          fenceToggle.setAttribute('data-state', 'rendered');
          fenceToggle.textContent = 'source';
        } else {
          const rendered = wrapper.querySelector('.mdFenceRendered') as HTMLElement | null;
          pre.style.display = '';
          if (rendered) rendered.style.display = 'none';
          fenceToggle.setAttribute('data-state', 'source');
          fenceToggle.textContent = 'render';
        }
        return;
      }
      const prToken = (e.target as HTMLElement | null)?.closest('[data-pr-ref]') as HTMLElement | null;
      if (prToken) {
        const ref = prToken.getAttribute('data-pr-ref');
        if (!ref) return;
        const addBtn = (e.target as HTMLElement | null)?.closest('.prAddBtn');
        // Every PR token comes from a URL, so the anchor form is the norm — only
        // the `+` needs the navigation suppressed.
        if (addBtn) e.preventDefault();
        if (addBtn && selectedSession?.sessionId) {
          // Optimistic: the chip lands on the next snapshot tick, which then
          // owns the class via the sync effect below.
          prToken.classList.add('prPinned');
          void fetch(`/api/sessions/${selectedSession.sessionId}/pr-refs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref }),
          })
            .then((r) => { if (!r.ok) prToken.classList.remove('prPinned'); })
            .catch(() => { prToken.classList.remove('prPinned'); });
        }
        return;
      }
      const jiraToken = (e.target as HTMLElement | null)?.closest('[data-jira-key]') as HTMLElement | null;
      if (jiraToken) {
        const key = jiraToken.getAttribute('data-jira-key');
        if (!key) return;
        const addBtn = (e.target as HTMLElement | null)?.closest('.jiraAddBtn');
        // A tokenized ticket URL is still a real link — only the `+` and the
        // bare-key tokens (which have no href) need the default suppressed.
        if (addBtn || jiraToken.tagName !== 'A') e.preventDefault();
        if (addBtn && selectedSession?.sessionId) {
          // Optimistic: the chip lands on the next snapshot tick, which then
          // owns the class via the sync effect below.
          jiraToken.classList.add('jiraPinned');
          void fetch(`/api/sessions/${selectedSession.sessionId}/jira-keys/${encodeURIComponent(key)}`, {
            method: 'POST',
          })
            .then((r) => { if (!r.ok) jiraToken.classList.remove('jiraPinned'); })
            .catch(() => { jiraToken.classList.remove('jiraPinned'); });
          return;
        }
        if (jiraBaseUrl) {
          window.open(`${jiraBaseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      const target = (e.target as HTMLElement | null)?.closest('[data-file-path]');
      if (target) {
        const path = target.getAttribute('data-file-path');
        if (path) {
          e.preventDefault();
          const lineAttr = target.getAttribute('data-file-line');
          const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
          setFileEditorTarget({ path, line: Number.isFinite(line) ? line : undefined });
        }
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        const raw = window.prompt('Open file (absolute path):', selectedSession?.cwd ? `${selectedSession.cwd}/CLAUDE.md` : '');
        if (raw) setFileEditorTarget(splitPathLine(raw.trim()));
      }
    };
    window.addEventListener('overlord:openFile', handler);
    window.addEventListener('keydown', keyHandler);
    document.addEventListener('click', clickHandler);
    return () => {
      window.removeEventListener('overlord:openFile', handler);
      window.removeEventListener('keydown', keyHandler);
      document.removeEventListener('click', clickHandler);
    };
  }, [selectedSession?.cwd, selectedSession?.sessionId, jiraBaseUrl]);

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
      const maxWidth = Math.max(900, window.innerWidth - 80);
      const next = Math.max(320, Math.min(maxWidth, dragStartWidth.current + delta));
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

  const [activeTab, setActiveTab] = useState<'conversation' | 'details' | 'subagents' | 'terminal' | 'notes' | 'artifacts'>('conversation');
  const [subagentActiveTab, setSubagentActiveTab] = useState<'conversation' | 'details'>('conversation');

  const [notesContent, setNotesContent] = useState('');
  const notesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesSessionIdRef = useRef<string | undefined>(undefined);
  const [notesFirstEditing, setNotesFirstEditing] = useState(false);
  const [notesFirstDraft, setNotesFirstDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [showIdleSubagents, setShowIdleSubagents] = useState(false);
  const [panelSearchQuery, setPanelSearchQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  // Extra feed items loaded from server when scrollTarget is near the top of the trimmed feed,
  // or lazily fetched for closed sessions (server drops their activityFeed from snapshots).
  // Declared up here so useTranscriptScroll can re-fire auto-scroll when extraFeed lands.
  const [extraFeed, setExtraFeed] = useState<ActivityItem[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [internalScrollTarget, setInternalScrollTarget] = useState<string | undefined>();
  const [internalScrollQuery, setInternalScrollQuery] = useState<string | undefined>();
  const panelSearchRef = useRef<HTMLInputElement>(null);
  // Effective scroll target: internal (panel search) takes priority over external (global search)
  const effectiveScrollTarget = internalScrollTarget ?? scrollTarget;
  const effectiveScrollQuery = internalScrollQuery ?? scrollQuery;
  const [localSent, setLocalSent] = useState<string[]>([]);
  const realCountAtFirstSend = useRef<number | null>(null);
  const sendTimestampMs = useRef<number | null>(null);
  const [sendInput2, setSendInput2] = useState('');
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const quickMenuRef = useRef<HTMLDivElement>(null);
  // Sent-message history: recall text the composer cleared but Claude never received.
  const [sentHistory, setSentHistory] = useState<SentEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [showHistoryMenu, setShowHistoryMenu] = useState(false);
  const preHistoryDraft = useRef('');
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const sendTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [showConvMenu, setShowConvMenu] = useState(false);
  const [copiedConv, setCopiedConv] = useState(false);
  const convMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showQuickMenu) return;
    const handler = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowQuickMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showQuickMenu]);
  useEffect(() => {
    if (!showHistoryMenu) return;
    const handler = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowHistoryMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistoryMenu]);
  useEffect(() => {
    if (!showConvMenu) return;
    const handler = (e: MouseEvent) => {
      if (convMenuRef.current && !convMenuRef.current.contains(e.target as Node)) {
        setShowConvMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showConvMenu]);
  const draftPerSession = useRef<Map<string, string>>(new Map());
  const localSentPerSession = useRef<Map<string, string[]>>(new Map());
  const realCountPerSession = useRef<Map<string, number | null>>(new Map());
  const sendTsPerSession = useRef<Map<string, number | null>>(new Map());
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  const prevOvrIdRef = useRef<string | undefined>(undefined);
  const [pastedImage, setPastedImage] = useState<{ path: string; previewUrl: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteArchive, setConfirmDeleteArchive] = useState(false);
  const [copyIdConfirm, setCopyIdConfirm] = useState(false);
  const [killing, setKilling] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [openingBridged, setOpeningBridged] = useState(false);
  const [connectMode, setConnectMode] = useState<'overlord' | 'terminal' | 'bridged'>('overlord');
const currentDisplayName =
    customName ??
    selectedSession?.proposedName ??
    selectedSession?.slug ??
    (selectedSession?.sessionId.slice(0, 8) ?? '');

  const selectedSubagent = selectedSubagentId
    ? selectedSession?.subagents.find(s => s.agentId === selectedSubagentId)
    : undefined;

  const elapsedSeconds = useElapsedSeconds(selectedSession?.lastActivity);

  const {
    transcriptRef,
    isAtBottomRef,
    scrollJumpLabels,
    handleTranscriptScroll,
    handleScrollJumpUp,
    handleScrollJumpDown,
    recomputeJump,
  } = useTranscriptScroll({
    feed: selectedSession?.activityFeed,
    extraFeed,
    subagentFeed: selectedSubagent?.activityFeed,
    activeTab,
    sendCount: localSent.length,
    hasScrollTarget: !!effectiveScrollTarget,
    onReachedBottomWithTarget: () => {
      setInternalScrollTarget(undefined);
      setInternalScrollQuery(undefined);
      onScrollTargetConsumed?.();
    },
  });

  // Keys already in this session's ticket context hide their `+`. Applied as a
  // class after render rather than baked into the HTML — renderMarkdown caches
  // by text alone and that cache is shared across sessions.
  const jiraKeySet = useMemo(
    () => new Set(selectedSession?.jiraKeys ?? []),
    [selectedSession?.jiraKeys],
  );
  // Same for PR tokens. Refs are case-insensitive on GitHub, so compare lowered.
  const prRefSet = useMemo(
    () => new Set((selectedSession?.prRefs ?? []).map((r) => r.toLowerCase())),
    [selectedSession?.prRefs],
  );
  useEffect(() => {
    const root = transcriptRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-jira-key]').forEach((el) => {
      el.classList.toggle('jiraPinned', jiraKeySet.has(el.getAttribute('data-jira-key') ?? ''));
    });
    root.querySelectorAll<HTMLElement>('[data-pr-ref]').forEach((el) => {
      el.classList.toggle('prPinned', prRefSet.has((el.getAttribute('data-pr-ref') ?? '').toLowerCase()));
    });
  }, [jiraKeySet, prRefSet, selectedSession?.activityFeed, extraFeed, activeTab, transcriptRef]);

  // Recompute jump pill state when transcript tab or target changes
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(recomputeJump);
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubagentId, subagentActiveTab, activeTab, selectedSession?.sessionId]);

  // Clear extraFeed and reset hasMore when session changes
  useEffect(() => {
    setExtraFeed([]);
    setHasMore(selectedSession?.feedTruncated ?? false);
  }, [selectedSession?.sessionId, selectedSession?.feedTruncated]);

  // Closed sessions: server drops activityFeed from the snapshot
  // (stateManager.composeSession), so fetch history once from disk.
  useEffect(() => {
    if (!selectedSession || selectedSession.state !== 'closed') return;
    if ((selectedSession.activityFeed?.length ?? 0) > 0) return;
    const controller = new AbortController();
    const sessionId = selectedSession.sessionId;
    fetch(`/api/sessions/${sessionId}/activity-before?timestamp=${encodeURIComponent(new Date().toISOString())}&limit=100`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((data: { items?: ActivityItem[]; hasMore?: boolean }) => {
        setExtraFeed(data.items ?? []);
        setHasMore(data.hasMore ?? false);
      })
      .catch(() => { /* ignore aborts and errors */ });
    return () => controller.abort();
  }, [selectedSession?.sessionId, selectedSession?.state]);

  // When scrollTarget is set: switch to conversation tab, fetch older messages if needed, then scroll
  useEffect(() => {
    if (!effectiveScrollTarget || !selectedSession) return;

    // Eagerly disable auto-scroll-to-bottom so subsequent feed updates
    // (tab switch, activity-before fetch, live activityFeed) don't stomp
    // the scroll-to-target animation before attemptScroll runs.
    isAtBottomRef.current = false;

    // Switch to conversation tab so the feed is visible
    setActiveTab('conversation');

    const feed = selectedSession.activityFeed ?? [];
    const targetIdx = feed.findIndex(item => item.timestamp === effectiveScrollTarget);
    const isNearTop = targetIdx >= 0 && targetIdx < 10;
    // Target may be in older history that's been trimmed out of activityFeed,
    // or may live inside a subagent's feed rendered inline — either way we
    // need to fetch earlier messages so the scroll handler can find it.
    const notInFeed = targetIdx === -1;

    // Load earlier messages if target is near the top of the trimmed feed
    if ((isNearTop || notInFeed) && feed.length > 0 && feed[0].timestamp) {
      const firstTs = feed[0].timestamp;
      fetch(`/api/sessions/${selectedSession.sessionId}/activity-before?timestamp=${encodeURIComponent(firstTs)}&limit=100`)
        .then(r => r.json())
        .then((data: { items?: ActivityItem[]; hasMore?: boolean }) => {
          if (data.items && data.items.length > 0) setExtraFeed(data.items);
          setHasMore(data.hasMore ?? false);
        })
        .catch(() => { /* ignore */ });
    }

    // Scroll after a short delay to allow render (first pass). If the target
    // isn't in the DOM yet (e.g. collapsed tool group just got expanded via
    // FeedSegments.scrollTargetTs effect), retry a second time.
    const attemptScroll = (): boolean => {
      const container = transcriptRef.current;
      if (!container) return false;
      const escaped = CSS.escape(effectiveScrollTarget);
      // Prefer exact data-ts match. Fall back to a tool group whose
      // data-ts-list contains this timestamp (word-separated).
      let el = container.querySelector<HTMLElement>(`[data-ts="${escaped}"]`);
      if (!el) el = container.querySelector<HTMLElement>(`[data-ts-list~="${escaped}"]`);
      if (!el) return false;
      // Walk past display:contents (zero-rect) wrappers to the first real child.
      let rectEl: HTMLElement = el;
      while (rectEl.getBoundingClientRect().height === 0 && rectEl.firstElementChild) {
        rectEl = rectEl.firstElementChild as HTMLElement;
      }
      if (rectEl.getBoundingClientRect().height === 0) return false;
      isAtBottomRef.current = false;

      // If we have the search query, try to find the matching text inside and
      // highlight only that span. Otherwise fall back to highlighting the row.
      const q = effectiveScrollQuery?.trim() ?? '';
      const highlightEl: HTMLElement = q ? (highlightMatchingText(rectEl, q) ?? rectEl) : rectEl;

      // Scroll every scrollable ancestor between the highlight and the outer
      // transcript container so matches inside inner scroll panes (e.g. code
      // blocks with max-height + overflow:auto) are actually brought into view.
      const scrollables: HTMLElement[] = [];
      for (let p: HTMLElement | null = highlightEl.parentElement; p && p !== container; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 1) {
          const style = getComputedStyle(p);
          if (/(auto|scroll)/.test(style.overflowY)) scrollables.push(p);
        }
      }
      scrollables.push(container);
      for (const sc of scrollables) {
        const scRect = sc.getBoundingClientRect();
        const tRect = highlightEl.getBoundingClientRect();
        const offset =
          tRect.top - scRect.top + sc.scrollTop
          - sc.clientHeight / 2 + tRect.height / 2;
        sc.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      }
      highlightEl.classList.add('searchHighlight');
      setTimeout(() => {
        highlightEl.classList.remove('searchHighlight');
        // If we wrapped a text span, unwrap it so the DOM returns to pristine.
        if (highlightEl.dataset.searchWrap === '1' && highlightEl.parentNode) {
          const parent = highlightEl.parentNode;
          while (highlightEl.firstChild) parent.insertBefore(highlightEl.firstChild, highlightEl);
          parent.removeChild(highlightEl);
          (parent as Element).normalize?.();
        }
      }, 10000);
      return true;
    };

    const consumeTarget = () => {
      setInternalScrollTarget(undefined);
      setInternalScrollQuery(undefined);
      onScrollTargetConsumed?.();
    };

    const tid = setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (attemptScroll()) {
            consumeTarget();
            return;
          }
          // Retry after a longer delay to let auto-expand + older-message fetch settle.
          setTimeout(() => {
            attemptScroll();
            consumeTarget();
          }, 250);
        });
      });
    }, 80);
    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveScrollTarget, effectiveScrollQuery]);

  // Reset scroll to bottom and edit state when selected session/subagent changes
  useEffect(() => {
    // Save current draft and pending messages before switching.
    // Drafts key on overlordId (stable across compaction / /clear / resume) — sessionId
    // rotates and strands the durable copy. localSent still keys on sessionId.
    const prevId = prevSessionIdRef.current;
    const prevOvr = prevOvrIdRef.current;
    if (prevOvr && sendInput2.trim()) {
      draftPerSession.current.set(prevOvr, sendInput2);
      saveDraft(prevOvr, sendInput2);
    } else if (prevOvr) {
      draftPerSession.current.delete(prevOvr);
      clearDraft(prevOvr);
    }
    if (prevId) {
      if (localSent.length > 0) {
        localSentPerSession.current.set(prevId, localSent);
        realCountPerSession.current.set(prevId, realCountAtFirstSend.current);
        sendTsPerSession.current.set(prevId, sendTimestampMs.current);
      } else {
        localSentPerSession.current.delete(prevId);
        realCountPerSession.current.delete(prevId);
        sendTsPerSession.current.delete(prevId);
      }
    }
    prevSessionIdRef.current = selectedSession?.sessionId;
    prevOvrIdRef.current = effectiveOvrId || undefined;

    // Don't scroll to bottom if we have a scroll target (search result click)
    isAtBottomRef.current = !effectiveScrollTarget;
    const raf = effectiveScrollTarget ? undefined : requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
    setIsEditing(false);
    setEditValue('');
    // Restore pending messages for the new session (or clear if none).
    // Check if messages were already confirmed while we were away — if so, discard them.
    const newId = selectedSession?.sessionId;
    const savedPending = newId ? (localSentPerSession.current.get(newId) ?? []) : [];
    const savedRealCount = newId ? (realCountPerSession.current.get(newId) ?? null) : null;
    const savedSendTs = newId ? (sendTsPerSession.current.get(newId) ?? null) : null;
    const currentCount = (selectedSession?.activityFeed ?? []).filter(i => i.role === 'user').length;
    // activityFeed is oldest-first — check NEWEST user message from the end
    const newestUserTsOnSwitch = [...(selectedSession?.activityFeed ?? [])].reverse().find(i => i.role === 'user')?.timestamp;
    const newestUserTsMsOnSwitch = newestUserTsOnSwitch ? new Date(newestUserTsOnSwitch).getTime() : 0;
    const countConfirmed = savedPending.length > 0 && savedRealCount !== null && currentCount > savedRealCount;
    const tsConfirmed = savedPending.length > 0 && savedSendTs !== null && newestUserTsMsOnSwitch >= savedSendTs;
    const alreadyConfirmed = countConfirmed || tsConfirmed;
    if (alreadyConfirmed && newId) {
      localSentPerSession.current.delete(newId);
      realCountPerSession.current.delete(newId);
      sendTsPerSession.current.delete(newId);
    }
    setLocalSent(alreadyConfirmed ? [] : savedPending);
    realCountAtFirstSend.current = alreadyConfirmed ? null : savedRealCount;
    sendTimestampMs.current = alreadyConfirmed ? null : savedSendTs;
    // Restore draft for the new session
    // In-memory draft first; fall back to the durable localStorage copy (survives reload).
    const newOvr = effectiveOvrId || undefined;
    migrateDraftKey(newId, newOvr);  // legacy sessionId-keyed drafts
    setSendInput2(newOvr ? (draftPerSession.current.get(newOvr) ?? loadDraft(newOvr)) : '');
    setSentHistory(loadSentHistory(newOvr));
    setHistoryIndex(null);
    setShowHistoryMenu(false);
    preHistoryDraft.current = '';
    setConfirmDelete(false);
    setConfirmDeleteArchive(false);
    setPastedImage(null);
    setKilling(false);
    setConfirmKill(false);
    setResuming(false);
    setPanelSearchQuery('');
    // Don't reset to conversation tab if a scroll target will switch us there
    if (!effectiveScrollTarget) setActiveTab('conversation');
    setSubagentActiveTab('conversation');
    return () => { if (raf !== undefined) cancelAnimationFrame(raf); };
    // Use overlordId (stable across /clear & resume lineage swaps), not sessionId,
    // so this only fires on a real user-driven session change.
  }, [selectedSession?.overlordId, selectedSubagentId]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!sessionId) return;
    notesSessionIdRef.current = sessionId;
    setNotesContent('');
    fetch(`/api/sessions/${sessionId}/notes`)
      .then(r => r.json())
      .then((data: { notes: string }) => {
        if (notesSessionIdRef.current !== sessionId) return;
        const content = data.notes ?? '';
        setNotesContent(content);
      })
      .catch(() => {});
  }, [selectedSession?.sessionId]);

  function startEdit() {
    setEditValue(currentDisplayName);
    setIsEditing(true);
  }

  const roomPrefix = useRoomPrefix(selectedSession?.cwd);

  // Room breadcrumb for the header — the room's basename, same value Room.name
  // carries. Derived, never stored: the session name itself is untouched.
  const roomLabel = useMemo(() => {
    const cwd = selectedSession?.cwd;
    if (!cwd) return '';
    return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  }, [selectedSession?.cwd]);

  // Crumb click = scroll the room into view on the left; double-click = also open
  // its detail panel. Debounce the single click so it doesn't fire mid-double-click.
  const crumbClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (crumbClickTimer.current) clearTimeout(crumbClickTimer.current); }, []);
  const handleCrumbClick = () => {
    const cwd = selectedSession?.cwd;
    if (!cwd) return;
    if (crumbClickTimer.current) clearTimeout(crumbClickTimer.current);
    crumbClickTimer.current = setTimeout(() => {
      crumbClickTimer.current = null;
      onNavigateRoom?.(cwd, false);
    }, 220);
  };
  const handleCrumbDoubleClick = () => {
    const cwd = selectedSession?.cwd;
    if (!cwd) return;
    if (crumbClickTimer.current) { clearTimeout(crumbClickTimer.current); crumbClickTimer.current = null; }
    onNavigateRoom?.(cwd, true);
  };

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      selectAfterPrefix(editInputRef.current, roomPrefix);
    }
  }, [isEditing, roomPrefix]);

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

  function sendText(text: string): boolean {
    if (!selectedSession || !text) return false;
    if (selectedSession.isCompacting) return false;
    const sent = injectText(effectiveOvrId, text, text.includes('@'));
    if (sent) {
      // Record before the composer clears — a send that lands mid-compaction is
      // swallowed by the TUI, and this ring is the only remaining copy.
      setSentHistory(pushSentHistory(effectiveOvrId, text, Date.now()));
      if (realCountAtFirstSend.current === null) {
        const feed = selectedSession.activityFeed ?? [];
        realCountAtFirstSend.current = feed.filter(i => i.role === 'user').length;
        sendTimestampMs.current = Date.now();
      }
      setLocalSent(prev => [...prev, text]);
    }
    return sent;
  }

  function handleSend() {
    if (!selectedSession) return;
    const text = sendInput2.trim();
    if (!text && !pastedImage) return;
    // During compaction, preserve the draft — injection will be queued but may be swallowed
    if (selectedSession.isCompacting) return;
    const full = pastedImage ? `${text} @${pastedImage.path}`.trim() : text;
    const sent = sendText(full);
    if (!sent) return; // preserve input + image if WebSocket not connected
    setSendInput2('');
    setHistoryIndex(null);
    preHistoryDraft.current = '';
    if (selectedSession) {
      draftPerSession.current.delete(effectiveOvrId);
      clearDraft(effectiveOvrId);
    }
    setPastedImage(null);
  }

  // Compaction swallows injected text. Snapshot whatever is in the composer the
  // moment it starts, so an unsent draft is recoverable from ↑ even if the user
  // never pressed Enter and the flag arrived too late to block the send.
  const wasCompacting = useRef(false);
  useEffect(() => {
    const now = !!selectedSession?.isCompacting;
    if (now && !wasCompacting.current && sendInput2.trim()) {
      setSentHistory(pushSentHistory(effectiveOvrId, sendInput2, Date.now()));
    }
    wasCompacting.current = now;
  }, [selectedSession?.isCompacting, sendInput2, effectiveOvrId]);

  // Memoized: this panel re-renders on every WebSocket tick.
  const recentSends = useMemo(() => sentHistory.slice(0, 10), [sentHistory]);

  /** Load a history entry into the composer without sending it. */
  function recallEntry(index: number) {
    const entry = sentHistory[index];
    if (!entry) return;
    if (historyIndex === null) preHistoryDraft.current = sendInput2;
    setHistoryIndex(index);
    setSendInput2(entry.text);
    saveDraft(effectiveOvrId, entry.text);
    requestAnimationFrame(() => {
      const el = sendTextareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function exitHistory(restore: boolean) {
    if (historyIndex === null) return;
    setHistoryIndex(null);
    if (restore) {
      setSendInput2(preHistoryDraft.current);
      saveDraft(effectiveOvrId, preHistoryDraft.current);
    }
    preHistoryDraft.current = '';
  }

  function handleExplain(quoted: string) {
    if (!selectedSession || !quoted) return;
    sendText(`Explain:\n\n${quoted}`);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't close on Escape — panel should stay open
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const isPty = selectedSession ? isPtySession(effectiveOvrId) : false;
  const isExited = selectedSession ? exitedSessions.has(effectiveOvrId) : false;
  const sessionError = selectedSession ? getError(effectiveOvrId) : undefined;
  // Treat embedded sessions with no live PTY as needing resume even when state
  // is 'waiting'/'working' — server-side process may still hold the lock but we
  // can't reach it (e.g. PTY map dropped after a server restart). Without this
  // the chat input lets the user type into a black hole.
  const needsResume = !!selectedSession && (
    selectedSession.state === 'closed' ||
    (selectedSession.sessionType === 'embedded' && selectedSession.ptyAlive === false)
  );

  useEffect(() => {
    if (resuming && !needsResume) setResuming(false);
  }, [resuming, needsResume]);

  useEffect(() => {
    if (!resuming) return;
    const t = setTimeout(() => setResuming(false), 15000);
    return () => clearTimeout(t);
  }, [resuming]);


  // Clear stale pending messages after 30s (safety net — count-based clearing handles normal flow)
  useEffect(() => {
    if (localSent.length === 0) return;
    const sessionId = selectedSession?.sessionId;
    const timer = setTimeout(() => {
      setLocalSent([]);
      realCountAtFirstSend.current = null;
      sendTimestampMs.current = null;
      if (sessionId) {
        localSentPerSession.current.delete(sessionId);
        realCountPerSession.current.delete(sessionId);
        sendTsPerSession.current.delete(sessionId);
      }
    }, 60_000);
    return () => clearTimeout(timer);
  }, [localSent, selectedSession?.sessionId]);

  // State-transition-based clearing removed: it raced with the transcript update.
  // Content-based deduplication (below) handles the normal path seamlessly.
  // The 5s timeout below is the only fallback for edge cases (injection failed, etc.).
  const prevSessionStateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    prevSessionStateRef.current = selectedSession?.state;
  }, [selectedSession?.state]);

  // Build merged activityFeed: real feed + optimistic locally-sent messages.
  // Confirmed when: (a) feed has more user messages than at send time (short sessions), OR
  // (b) the most recent user message in the feed has a timestamp >= our send time (long sessions
  //     where the feed is at max capacity and user-count stays flat).

  const rawFeed = selectedSession?.activityFeed;
  // Stable reference when rawFeed is undefined — prevents downstream memos from busting every render.
  const realFeed = useMemo<ActivityItem[]>(() => rawFeed ?? [], [rawFeed]);
  const currentUserCount = realFeed.filter(i => i.role === 'user').length;
  const prevUserCount = realCountAtFirstSend.current ?? currentUserCount;
  // activityFeed is oldest-first — find the NEWEST user message by searching from the end
  const newestUserTs = [...realFeed].reverse().find(i => i.role === 'user')?.timestamp;
  const newestUserTsMs = newestUserTs ? new Date(newestUserTs).getTime() : 0;
  // Server-provided newest user-message ts from the UNTRIMMED feed. Confirms the echo
  // even in long tool-heavy turns where the user message is evicted from the 30-item
  // tail (currentUserCount stays 0, newestUserTsMs degrades to 0). Without this the
  // echo stays pinned after the AskUserQuestion until the 60s safety timer fires.
  const serverUserTsMs = selectedSession?.lastUserMessageTs
    ? new Date(selectedSession.lastUserMessageTs).getTime() : 0;
  const confirmed = currentUserCount > prevUserCount ||
    (sendTimestampMs.current !== null && newestUserTsMs >= sendTimestampMs.current) ||
    (sendTimestampMs.current !== null && serverUserTsMs >= sendTimestampMs.current);

  // Clear pending messages via useEffect (not queueMicrotask during render) to avoid
  // a race where the session-switch effect saves stale localSent before the microtask fires.
  useEffect(() => {
    if (!confirmed || localSent.length === 0) return;
    const sessionId = selectedSession?.sessionId;
    setLocalSent([]);
    realCountAtFirstSend.current = null;
    sendTimestampMs.current = null;
    if (sessionId) {
      localSentPerSession.current.delete(sessionId);
      realCountPerSession.current.delete(sessionId);
      sendTsPerSession.current.delete(sessionId);
    }
  }, [confirmed, localSent.length, selectedSession?.sessionId]);

  // Render a pending (unanswered) AskUserQuestion as the last feed item so it flows
  // inline and interactive (no floating overlay). Skip if the feed already ends with
  // an unanswered AskUserQuestion (avoid double-showing).
  const lastRealItem = realFeed[realFeed.length - 1];
  const feedTrailsPendingQuestion = lastRealItem?.toolName === 'AskUserQuestion' && !lastRealItem.resultJson;
  const pendingQuestionItem: ActivityItem | null = (selectedSession?.pendingQuestion && !feedTrailsPendingQuestion)
    ? {
        kind: 'tool',
        toolName: 'AskUserQuestion',
        content: selectedSession.pendingQuestion.questions.map(q => q.question).join(' · ').slice(0, 200),
        inputJson: JSON.stringify({ questions: selectedSession.pendingQuestion.questions, kind: selectedSession.pendingQuestion.kind }),
      }
    : null;
  // The assistant text above the menu. Claude writes nothing of an AskUserQuestion
  // turn to the transcript until it is answered — the text block included — so while
  // the menu is up the screen-scraped preamble is the only copy. Dropped as soon as
  // the transcript catches up (guard below), which is when pendingQuestion clears.
  const questionPreamble = pendingQuestionItem ? selectedSession?.pendingQuestion?.preamble : undefined;
  const preambleItem: ActivityItem | null = (() => {
    if (!questionPreamble) return null;
    const head = questionPreamble.slice(0, 40);
    for (let i = realFeed.length - 1, seen = 0; i >= 0 && seen < 3; i--) {
      const it = realFeed[i];
      if (it.kind !== 'message') continue;
      seen++;
      if (it.role === 'assistant' && it.content?.startsWith(head)) return null;
    }
    return { kind: 'message', role: 'assistant', content: questionPreamble };
  })();

  const mergedFeed: ActivityItem[] = [
    ...extraFeed,
    ...realFeed,
    ...(confirmed ? [] : localSent.map(t => ({ kind: 'message' as const, role: 'user' as const, content: t, pending: true }))),
    ...(preambleItem ? [preambleItem] : []),
    ...(pendingQuestionItem ? [pendingQuestionItem] : []),
  ];

  // Pinned user message atop the Conversation feed. One instance serves the
  // main and subagent feeds — they share `transcriptRef`, and only one is
  // mounted at a time.
  const { sticky, recomputeSticky, scrollToPrev, scrollToNext } = useStickyUserMessage({
    containerRef: transcriptRef,
    feedKey: mergedFeed.length,
    extraKey: selectedSubagent?.activityFeed?.length,
    viewKey: `${selectedSession?.sessionId ?? ''}/${selectedSubagentId ?? ''}/${activeTab}/${subagentActiveTab}`,
    enabled: showStickyUserMessage,
  });

  const handleScrollWithSticky = useCallback(() => {
    handleTranscriptScroll();
    recomputeSticky();
  }, [handleTranscriptScroll, recomputeSticky]);

  const panelSearchResults = useMemo(() => {
    const q = panelSearchQuery.trim();
    if (!q) return [];
    return searchFeed(mergedFeed, q);
  }, [panelSearchQuery, mergedFeed]);

  const lastUserMessage = [...mergedFeed].reverse().find(m => m.kind === 'message' && m.role === 'user')?.content ?? '';
  const isAbandoned = selectedSession != null && selectedSession.state === 'closed' && (Date.now() - new Date(selectedSession.lastActivity).getTime()) > 30 * 60 * 1000;
  const hasSubagents = (selectedSession?.subagents.length ?? 0) > 0;

  const stateBarActiveSubagents = selectedSession
    ? selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking')
    : [];
  const stateBarNeedsApproval = selectedSession?.needsPermission === true;
  const stateBarHasQuestion = !stateBarNeedsApproval && !!selectedSession?.pendingQuestion && !selectedSession.questionStale;
  const isCompacting = selectedSession?.isCompacting === true;
  const stateBarScheduledAt = selectedSession?.state === 'waiting' && !stateBarNeedsApproval && !stateBarHasQuestion
    ? selectedSession.scheduledWakeupAt
    : undefined;
  // A waiting session with an in-flight background command is not user-blocked —
  // the harness re-invokes it on exit. Scheduled wakeup wins if both are pending.
  const stateBarBackgroundTask = selectedSession?.state === 'waiting'
    && !stateBarNeedsApproval && !stateBarHasQuestion && !stateBarScheduledAt
    ? selectedSession.backgroundTasks?.[0]
    : undefined;
  const stateBarLabel = isCompacting ? 'Compacting conversation…'
    : stateBarNeedsApproval ? 'Waiting for approval'
    : stateBarHasQuestion ? 'Question for you'
    : stateBarScheduledAt ? new Date(stateBarScheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : stateBarBackgroundTask ? 'Running in background'
    : selectedSession?.state === 'waiting' && stateBarActiveSubagents.length > 0 ? 'Delegated · waiting for subagent'
    : selectedSession?.state === 'waiting' ? 'Waiting for input'
    : selectedSession?.state === 'thinking' ? 'Thinking...'
    : 'Working...';
  const stateBarClass = isCompacting ? styles.stateBarCompacting
    : stateBarNeedsApproval ? styles.stateBarPermission
    : stateBarHasQuestion ? styles.stateBarQuestion
    : stateBarScheduledAt ? styles.stateBarScheduled
    : stateBarBackgroundTask ? styles.stateBarBackground
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
                sessionId={effectiveOvrId}
                onInput={(data) => sendInput(effectiveOvrId, data)}
                onResize={(cols, rows) => resizePty(effectiveOvrId, cols, rows)}
                registerOutputHandler={registerOutputHandler}
                fillHeight
              />
            </div>
          </>
        )}
        {selectedSession && (
          <>
            {/* Context progress strip */}
            {selectedSession.inputTokens !== undefined ? (() => {
              const contextWindow = getContextWindow(selectedSession.model, selectedSession.inputTokens);
              const pct = Math.min(100, (selectedSession.inputTokens / contextWindow) * 100);
              const usedK = (selectedSession.inputTokens / 1000).toFixed(0);
              const totalK = (contextWindow / 1000).toFixed(0);
              const fillColor = selectedSession.color;
              const compactCount = selectedSession.compactCount ?? 0;
              const tooltip = `Context: ${usedK}k / ${totalK}k · ${pct.toFixed(0)}%${compactCount > 0 ? ` · ${compactCount}× compacted` : ''}${selectedSession.isCompacting ? ' · compacting…' : ''}`;
              return (
                <div className={styles.contextStrip} title={tooltip}>
                  <div className={styles.contextStripFill} style={{ width: `${pct}%`, background: fillColor }} />
                </div>
              );
            })() : (
              <div className={styles.colorStrip} style={{ background: selectedSession.color }} />
            )}

            {/* Close button */}
            <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">
              &times;
            </button>

            {selectedSubagent ? (
              /* Subagent view */
              <>
                <div className={styles.panelHeader}>
                  <div className={styles.headerWithAvatar}>
                    <button
                      className={styles.backToParentBtn}
                      onClick={() => {
                        if (!onSelectSession) return;
                        const feed = selectedSession.activityFeed ?? [];
                        const desc = selectedSubagent.description;
                        let targetTs: string | undefined;
                        for (let i = feed.length - 1; i >= 0; i--) {
                          const item = feed[i];
                          if (item.kind === 'tool' && item.toolName === 'Agent' && item.inputJson) {
                            try {
                              const input = JSON.parse(item.inputJson);
                              if (input.description === desc) {
                                targetTs = item.timestamp;
                                break;
                              }
                            } catch {}
                          }
                        }
                        onSelectSession(selectedSession, undefined, targetTs);
                      }}
                      title="Back to parent — jump to where this agent was called"
                      aria-label="Back to parent agent"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
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
                  <div className={styles.scrollAreaWrap}>
                    <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleScrollWithSticky}>
                      <section className={styles.section}>
                        {selectedSubagent.activityFeed?.length ? (
                          <div className={styles.transcript}>
                            <FeedSegments
                              feed={selectedSubagent.activityFeed}
                              roleLabel={(role) => role === 'user' ? 'parent' : assistantLabel(selectedSession.provider)}
                              styles={styles as Record<string, string>}
                              ideName={selectedSession.ideName}
                              sessionState={selectedSubagent.state}
                              cwd={selectedSession.cwd}
                              markUserMessages
                            />
                          </div>
                        ) : (
                          <div className={styles.messageBox}>No activity recorded yet.</div>
                        )}
                      </section>
                    </div>
                    <StickyUserHeader sticky={sticky} label="parent" onPrev={scrollToPrev} onNext={scrollToNext} styles={styles} />
                    <ScrollJumpNav
                      up={scrollJumpLabels.up}
                      down={scrollJumpLabels.down}
                      onUp={handleScrollJumpUp}
                      onDown={handleScrollJumpDown}
                      styles={styles}
                    />
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
                            <span className={styles.fieldValue}>{formatModel(selectedSubagent.model)}</span>
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
                    <ColorPicker
                      sessionId={selectedSession.sessionId}
                      color={selectedSession.color}
                      size={44}
                      icon={selectedSession.icon}
                      onChange={(newColor) => {
                        void fetch(`/api/sessions/${selectedSession.sessionId}/color`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ color: newColor }),
                        }).then(r => {
                          if (!r.ok) console.warn('[color] PUT failed', r.status, selectedSession.sessionId);
                        }).catch(e => console.warn('[color] PUT error', e));
                      }}
                      onIconChange={(newIcon) => {
                        void fetch(`/api/sessions/${selectedSession.sessionId}/icon`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ icon: newIcon }),
                        }).then(r => {
                          if (!r.ok) console.warn('[icon] PUT failed', r.status, selectedSession.sessionId);
                        }).catch(e => console.warn('[icon] PUT error', e));
                      }}
                    />
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
                        {roomLabel && (
                          <span
                            className={`${styles.roomCrumb} ${onNavigateRoom ? styles.roomCrumbClickable : ''}`}
                            title={onNavigateRoom ? `${selectedSession.cwd}\n\nClick: scroll to room · Double-click: open room details` : selectedSession.cwd}
                            role={onNavigateRoom ? 'button' : undefined}
                            tabIndex={onNavigateRoom ? 0 : undefined}
                            onClick={onNavigateRoom ? handleCrumbClick : undefined}
                            onDoubleClick={onNavigateRoom ? handleCrumbDoubleClick : undefined}
                            onKeyDown={onNavigateRoom ? (e) => { if (e.key === 'Enter') handleCrumbDoubleClick(); } : undefined}
                          >
                            {roomLabel}
                            <span className={styles.roomCrumbSep} aria-hidden="true">›</span>
                          </span>
                        )}
                        <h2 className={styles.sessionName} onDoubleClick={startEdit} title="Double-click to rename">{currentDisplayName}</h2>
                        <button
                          className={styles.nameBtn}
                          onClick={() => navigator.clipboard.writeText(`name: ${currentDisplayName} id: ${selectedSession.sessionId}${selectedSession.overlordId ? ` ovrId: ${selectedSession.overlordId}` : ''}`)}
                          title={`Copy name + ID${selectedSession.overlordId ? ' + ovrId' : ''}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/>
                            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/>
                          </svg>
                        </button>
                      </>
                    )}
                  </div>

                  {/* Notes line is always rendered (empty shows a click-to-edit placeholder)
                      so the subtitle can be written without opening the Notes tab. */}
                  {!selectedSession.isWorker && (!selectedSession.isArchived || notesContent.trim() || selectedSession.intent) && ((() => {
                    const noteFirst = getFirstLineInfo(notesContent).text;
                    return (
                    <div className={styles.currentTaskCard}>
                      {(!selectedSession.isArchived || notesContent.trim()) && (
                        <div className={styles.currentTaskLine}>
                          <span className={styles.currentTaskLabel}>Notes:</span>
                          {notesFirstEditing ? (
                            <input
                              className={styles.notesFirstLineInput}
                              value={notesFirstDraft}
                              autoFocus
                              onChange={(e) => setNotesFirstDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  (e.currentTarget as HTMLInputElement).blur();
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setNotesFirstEditing(false);
                                }
                              }}
                              onBlur={() => {
                                const sessionId = selectedSession.sessionId;
                                const { index } = getFirstLineInfo(notesContent);
                                const lines = notesContent.split('\n');
                                while (lines.length <= index) lines.push('');
                                lines[index] = notesFirstDraft;
                                const next = lines.join('\n');
                                setNotesContent(next);
                                setNotesFirstEditing(false);
                                if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current);
                                fetch(`/api/sessions/${sessionId}/notes`, {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ notes: next }),
                                }).then(() => updateNoteFirstLine(sessionId, next)).catch(() => {});
                              }}
                            />
                          ) : (
                            <span
                              className={`${styles.currentTaskTitle} ${styles.headerSummaryText} ${styles.notesEditable} ${noteFirst ? '' : styles.notesFirstLineEmpty}`}
                              onClick={(e) => {
                                const t = e.target as HTMLElement;
                                if (t.closest('a')) return;
                                setNotesFirstDraft(noteFirst);
                                setNotesFirstEditing(true);
                              }}
                              title="Click to edit"
                            >
                              {noteFirst ? renderWithLinks(noteFirst, styles.notesFirstLineLink) : 'Add a note…'}
                              <span className={styles.notesEditIndicator} aria-hidden="true">✎</span>
                            </span>
                          )}
                        </div>
                      )}
                      {selectedSession.intent && (
                        <span className={styles.currentTaskLine}>
                          <span className={styles.currentTaskLabel}>Intent:</span>
                          <span className={`${styles.currentTaskTitle} ${styles.headerSummaryText}`}>{selectedSession.intent}</span>
                        </span>
                      )}
                    </div>
                    );
                  })())}

                  <div className={styles.summaryRow}>
                    {selectedSession.isArchived ? (
                      <>
                        <span
                          className={styles.stateBadge}
                          style={{ background: '#6b7280', color: '#0b0b14', letterSpacing: '0.08em' }}
                          title={selectedSession.archivedAt ? `Archived ${new Date(selectedSession.archivedAt).toLocaleString()}` : 'Archived'}
                        >
                          ARCHIVED
                        </span>
                        {selectedSession.archivedGitBranch && (
                          <span className={styles.launchBadge} data-category="terminal" title={`Branch at archive time: ${selectedSession.archivedGitBranch}`}>
                            {selectedSession.archivedGitBranch}
                          </span>
                        )}
                        {selectedSession.archivedPullRequest && (
                          <a
                            href={selectedSession.archivedPullRequest.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.launchBadge}
                            data-category="terminal"
                            title={selectedSession.archivedPullRequest.title}
                            style={{ textDecoration: 'none' }}
                          >
                            #{selectedSession.archivedPullRequest.number}
                          </a>
                        )}
                        {onResumeArchived && (
                          <button
                            className={styles.resumeBtn}
                            onClick={() => onResumeArchived(selectedSession.sessionId, selectedSession.cwd)}
                            title="Unarchive and resume this session in place"
                          >
                            Resume this
                          </button>
                        )}
                        {onCloneArchived && (
                          <button
                            className={styles.resumeBtn}
                            style={{ marginLeft: 6, background: 'rgba(99, 102, 241, 0.1)', borderColor: 'rgba(99, 102, 241, 0.35)', color: '#818cf8' }}
                            onClick={() => onCloneArchived(selectedSession.sessionId, selectedSession.cwd)}
                            title="Spawn a new session branched from this archived transcript"
                          >
                            Resume as clone
                          </button>
                        )}
                        {onDeleteArchived && (confirmDeleteArchive ? (
                          <>
                            <span className={styles.deleteConfirmInline} style={{ marginLeft: 6 }}>Delete permanently?</span>
                            <button
                              className={styles.deleteConfirmBtn}
                              onClick={() => { setConfirmDeleteArchive(false); onDeleteArchived(selectedSession.sessionId); }}
                            >
                              Yes
                            </button>
                            <button className={styles.deleteCancelBtn} onClick={() => setConfirmDeleteArchive(false)}>No</button>
                          </>
                        ) : (
                          <button
                            className={styles.resumeBtn}
                            style={{ marginLeft: 6, background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.35)', color: '#f87171' }}
                            onClick={() => setConfirmDeleteArchive(true)}
                            title="Permanently delete this archived session and its transcripts. Cannot be undone."
                          >
                            Delete
                          </button>
                        ))}
                      </>
                    ) : (<>
                    <StateBadge
                      state={selectedSession.state}
                      activeSubagentCount={selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking').length || undefined}
                      review={selectedSession.review}
                      parkReason={selectedSession.parkReason}
                      onSetReview={(review, reason) => {
                        void fetch(`/api/sessions/${selectedSession.sessionId}/review`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ review, reason }),
                        });
                      }}
                    />
                    {(() => {
                      const l = getLaunchInfo(selectedSession, isPty);
                      const canFocus = !!(selectedSession.bridgeTty && platform === 'darwin' && onFocusBridge);
                      if (canFocus) {
                        return (
                          <button
                            className={`${styles.launchBadge} ${styles.launchBadgeFocusable}`}
                            data-category={l.category}
                            data-tooltip="Click to bring terminal window to front"
                            onClick={() => onFocusBridge!(selectedSession.sessionId)}
                          >
                            {l.name} ↗
                          </button>
                        );
                      }
                      return (
                        <span className={styles.launchBadge} data-category={l.category} data-tooltip={`Launch: ${l.name}`}>{l.name}</span>
                      );
                    })()}
                    {selectedSession.permissionMode && (() => {
                      const mode = selectedSession.permissionMode;
                      const known = mode === 'bypassPermissions' || mode === 'acceptEdits' || mode === 'plan' || mode === 'default';
                      const label =
                        mode === 'bypassPermissions' ? 'bypass' :
                        mode === 'acceptEdits' ? 'accept-edits' :
                        mode === 'plan' ? 'plan' :
                        mode === 'default' ? 'ask' :
                        mode;
                      const tooltip =
                        mode === 'bypassPermissions' ? 'Bypass all permissions — click to change' :
                        mode === 'acceptEdits' ? 'Auto-accept edits — click to change' :
                        mode === 'plan' ? 'Plan mode only — click to change' :
                        mode === 'default' ? 'Ask for permissions (default) — click to change' :
                        `Mode: ${mode} — click to change`;
                      return (
                        <button
                          type="button"
                          className={`${styles.permissionModeBadge} ${styles.permissionModeBadgeClickable}`}
                          data-mode={known ? mode : 'custom'}
                          data-tooltip={tooltip}
                          onMouseDown={(e) => { e.preventDefault(); }}
                          onClick={async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.blur();
                            try {
                              await fetch(`/api/sessions/${selectedSession.sessionId}/cycle-permission-mode`, {
                                method: 'POST',
                              });
                            } catch { /* ignore */ }
                          }}
                        >
                          {label}
                        </button>
                      );
                    })()}
                    </>)}
                    <span className={`${styles.summaryMeta} ${styles.summaryMetaAgo}`} data-tooltip={`Last activity: ${new Date(selectedSession.lastActivity).toLocaleString()}`}>{formatRelativeTime(selectedSession.lastActivity)}</span>
                    {selectedSession.model && <span className={styles.summaryMeta} data-tooltip={`Model: ${selectedSession.model}`}>{formatModel(selectedSession.model)}</span>}
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
                  {!selectedSession.isArchived && (
                    <button
                      className={`${styles.tab} ${activeTab === 'notes' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('notes')}
                    >
                      Notes{notesContent.trim() && <span className={styles.tabNotesDot}>✱</span>}
                    </button>
                  )}
                  {!selectedSession.isArchived && (
                    <button
                      className={`${styles.tab} ${activeTab === 'artifacts' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('artifacts')}
                    >
                      Artifacts
                    </button>
                  )}
                  {!selectedSession.isArchived && hasSubagents && (
                    <button
                      className={`${styles.tab} ${activeTab === 'subagents' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('subagents')}
                    >
                      Subagents
                    </button>
                  )}
                  {!selectedSession.isArchived && (isPty || selectedSession.sessionType === 'embedded' || isBridgeSession?.(effectiveOvrId)) && (
                    <button
                      className={`${styles.tab} ${activeTab === 'terminal' ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab('terminal')}
                    >
                      Terminal
                      {(isPty || isBridgeSession?.(effectiveOvrId)) ? (
                        <span className={styles.tabPtyBadge}>{isBridgeSession?.(effectiveOvrId) && !isPty ? 'Bridge' : 'PTY'}</span>
                      ) : (
                        <>
                          <span className={styles.tabPtyBadgeEnded}>PTY</span>
                          <span style={{ fontSize: '10px', color: '#666' }}>(ended)</span>
                        </>
                      )}
                    </button>
                  )}
                  {/* In-panel search */}
                  <div className={styles.panelSearchWrap} style={{ marginLeft: 'auto' }}>
                    <div className={styles.panelSearchInputWrap}>
                      <svg className={styles.panelSearchIcon} width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <input
                        ref={panelSearchRef}
                        type="text"
                        className={styles.panelSearchInput}
                        placeholder="Search this session…"
                        value={panelSearchQuery}
                        onChange={e => setPanelSearchQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') setPanelSearchQuery('');
                        }}
                      />
                      {panelSearchQuery && (
                        <>
                          <span className={styles.panelSearchCount}>
                            {panelSearchResults.length}
                          </span>
                          <button
                            className={styles.panelSearchClose}
                            onClick={() => setPanelSearchQuery('')}
                            title="Clear (Esc)"
                          >✕</button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Conversation menu */}
                  <div className={styles.convMenuAnchor} ref={convMenuRef}>
                    <button
                      className={styles.convMenuTrigger}
                      title="Conversation options"
                      onClick={() => setShowConvMenu(v => !v)}
                    >
                      <span className={styles.burgerIcon} />
                    </button>
                    {showConvMenu && (
                      <div className={styles.convMenu}>
                        <button
                          className={styles.quickMenuItem}
                          onClick={() => {
                            const text = mergedFeed
                              .filter(i => i.kind === 'message' && (i.role === 'user' || i.role === 'assistant'))
                              .map(i => `[${i.role?.toUpperCase()}]\n${i.content ?? ''}`)
                              .join('\n\n---\n\n');
                            navigator.clipboard.writeText(text);
                            setCopiedConv(true);
                            setTimeout(() => { setCopiedConv(false); setShowConvMenu(false); }, 1200);
                          }}
                        >
                          {copiedConv ? '✓ Copied' : 'Copy conversation'}
                        </button>
                        {onCloneSession && !selectedSession.isArchived && mergedFeed.length > 0 && (
                          <button
                            className={styles.quickMenuItem}
                            title="Spawn a new session forked from this conversation"
                            onClick={() => {
                              onCloneSession(selectedSession.sessionId);
                              setShowConvMenu(false);
                            }}
                          >
                            Clone conversation
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Panel search results dropdown */}
                {panelSearchQuery.trim() && (
                  <div className={styles.panelSearchResults}>
                    {panelSearchResults.length === 0 ? (
                      <div className={styles.panelSearchEmpty}>No matches</div>
                    ) : (
                      panelSearchResults.map((match, i) => {
                        const role = match.item.role ?? match.item.kind;
                        const roleLabel = match.item.kind === 'tool' ? (match.item.toolName ?? 'tool') : role;
                        return (
                          <div
                            key={i}
                            className={styles.panelSearchRow}
                            onClick={() => {
                              if (match.item.timestamp) {
                                setInternalScrollTarget(match.item.timestamp);
                                setInternalScrollQuery(panelSearchQuery.trim());
                              }
                            }}
                          >
                            <span className={`${styles.panelSearchRole} ${styles[`panelSearchRole_${role}`] ?? ''}`}>
                              {roleLabel}
                            </span>
                            <span className={styles.panelSearchExcerpt}>
                              <BoldExcerpt text={match.excerpt} ranges={match.boldRanges} />
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* Bridge dead banner */}
                {selectedSession.bridgeDead && selectedSession.state !== 'closed' && (
                  <div className={styles.bridgeDeadBanner}>
                    <span>Bridge pipe lost — terminal feed disconnected.</span>
                    <div className={styles.bridgeDeadActions}>
                      <button
                        className={styles.bridgeDeadKillResume}
                        onClick={() => {
                          fetch(`/api/sessions/${selectedSession.sessionId}/kill-process`, { method: 'POST' })
                            .then(() => {
                              // Wait for process to die, then resume
                              setTimeout(() => {
                                onResumeSession?.(selectedSession.sessionId, selectedSession.cwd);
                              }, 1500);
                            });
                        }}
                      >
                        Kill &amp; Resume
                      </button>
                      <button
                        className={styles.bridgeDeadKill}
                        onClick={() => {
                          fetch(`/api/sessions/${selectedSession.sessionId}/kill-process`, { method: 'POST' });
                        }}
                      >
                        Kill
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab: Conversation */}
                {activeTab === 'conversation' && (
                  <>
                    {/* Non-PTY: transcript + state bar + send input */}
                      <div className={styles.scrollAreaWrap}>
                        <div className={styles.scrollArea} ref={transcriptRef} onScroll={handleScrollWithSticky}>
                          {selectedSession.activeMonitors && selectedSession.activeMonitors.length > 0 && (
                            <div className={styles.watchingSection}>
                              <span className={styles.watchingHeader}>
                                <span className={styles.watchingDot} />
                                Watching
                                {selectedSession.activeMonitors.length > 1 ? ` (${selectedSession.activeMonitors.length})` : ''}
                              </span>
                              <ul className={styles.watchingList}>
                                {selectedSession.activeMonitors.map(m => (
                                  <li key={m.toolUseId} className={styles.watchingItem}>
                                    <span className={styles.watchingTarget}>{m.target || m.toolUseId.slice(0, 8)}</span>
                                    {m.until && <span className={styles.watchingUntil}>until {m.until}</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {selectedSession.review === 'parked' && (
                            <div className={styles.parkedBanner}>
                              <span>⏸ Parked{selectedSession.parkedAt ? ` ${formatParkedAge(selectedSession.parkedAt)}` : ''}</span>
                              {selectedSession.parkReason && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className={styles.parkedBannerReason} title={selectedSession.parkReason}>
                                    {selectedSession.parkReason}
                                  </span>
                                </>
                              )}
                              <button
                                className={styles.parkedBannerBtn}
                                onClick={() => {
                                  void fetch(`/api/sessions/${selectedSession.sessionId}/review`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ review: null }),
                                  });
                                }}
                              >
                                Un-park
                              </button>
                            </div>
                          )}
                          {(mergedFeed.length > 0 || selectedSession.lastMessage) ? (
                            <section className={styles.section}>
                              {mergedFeed.length > 0 ? (
                                <div className={styles.transcript}>
                                  {hasMore && (
                                    <div className={styles.loadOlderWrap}>
                                      <button
                                        className={styles.loadOlderBtn}
                                        disabled={loadingOlder}
                                        onClick={() => {
                                          const oldest = mergedFeed[0]?.timestamp;
                                          if (!oldest || loadingOlder) return;
                                          setLoadingOlder(true);
                                          fetch(`/api/sessions/${selectedSession.sessionId}/activity-before?timestamp=${encodeURIComponent(oldest)}&limit=100`)
                                            .then(r => r.json())
                                            .then((data: { items?: ActivityItem[]; hasMore?: boolean }) => {
                                              if (data.items && data.items.length > 0) {
                                                setExtraFeed(prev => [...data.items!, ...prev]);
                                              }
                                              setHasMore(data.hasMore ?? false);
                                            })
                                            .catch(() => { /* ignore */ })
                                            .finally(() => setLoadingOlder(false));
                                        }}
                                      >
                                        {loadingOlder ? '…' : '· · ·'}
                                      </button>
                                    </div>
                                  )}
                                  <FeedSegments
                                    feed={mergedFeed}
                                    roleLabel={(role) => role === 'user' ? 'you' : assistantLabel(selectedSession.provider)}
                                    styles={styles as Record<string, string>}
                                    ideName={selectedSession.ideName}
                                    sessionState={selectedSession.state}
                                    isPty={isPty}
                                    cwd={selectedSession.cwd}
                                    subagents={selectedSession.subagents}
                                    onSelectSubagent={(agentId) => onSelectSession?.(selectedSession, agentId)}
                                    scrollTargetTs={effectiveScrollTarget ?? undefined}
                                    questionSessionId={selectedSession.sessionId}
                                    questionStageRef={questionStageRef}
                                    onQuestionDismissedToChat={() => sendTextareaRef.current?.focus()}
                                    questionStale={selectedSession.questionStale}
                                    markUserMessages
                                  />
                                </div>
                              ) : (
                                <div className={styles.messageBox}>{selectedSession.lastMessage}</div>
                              )}
                            </section>
                          ) : selectedSession.needsPermission ? (
                            <div className={styles.emptyFeedPrompt}>
                              <PermissionPrompt
                                sessionId={selectedSession.sessionId}
                                promptText={selectedSession.permissionPromptText}
                                isLimitPrompt={selectedSession.isLimitPrompt}
                                styles={styles}
                              />
                            </div>
                          ) : selectedSession.sessionType === 'bridge' ? (
                            <div className={styles.emptyFeedBridge}>
                              <span>Session started. Interact via the bridge terminal.</span>
                              <button className={styles.emptyFeedBridgeBtn} onClick={() => setActiveTab('terminal')}>Open Terminal</button>
                            </div>
                          ) : null}
                        </div>
                        <StickyUserHeader sticky={sticky} label="you" onPrev={scrollToPrev} onNext={scrollToNext} styles={styles} />
                        <ScrollJumpNav
                          up={scrollJumpLabels.up}
                          down={scrollJumpLabels.down}
                          onUp={handleScrollJumpUp}
                          onDown={handleScrollJumpDown}
                          styles={styles}
                        />
                      </div>
                      {selectedSession.sessionType !== 'bridge' && (
                        <ConsolePreview
                          sessionId={selectedSession.sessionId}
                          sessionState={selectedSession.state}
                          isPty={isPty}
                          sessionType={selectedSession.sessionType}
                        />
                      )}
                      {selectedSession && selectedSession.state !== 'closed' && (
                        <>
                          <div className={`${styles.stateBar} ${stateBarClass}`}>
                            {stateBarScheduledAt ? (
                              <svg className={styles.stateBarClock} width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
                                <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                                <path d="M 6 3.2 L 6 6 L 8 7.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : stateBarBackgroundTask ? (
                              <svg className={styles.stateBarClock} width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
                                <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3.5 2.5" />
                              </svg>
                            ) : (
                              <span className={styles.stateBarDot} />
                            )}
                            <span className={styles.stateBarLabel}>{stateBarLabel}</span>
                            {elapsedSeconds > 2 && !stateBarScheduledAt && !stateBarBackgroundTask && (
                              <span className={styles.stateBarElapsed}>{formatElapsed(elapsedSeconds)}</span>
                            )}
                            {stateBarBackgroundTask && (
                              <>
                                <span
                                  className={styles.stateBarReason}
                                  title={stateBarBackgroundTask.outputFile ?? stateBarBackgroundTask.taskId}
                                >
                                  {stateBarBackgroundTask.description ?? stateBarBackgroundTask.taskId}
                                </span>
                                {stateBarBackgroundTask.startedAt && (
                                  <span className={styles.stateBarElapsed}>
                                    {formatElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(stateBarBackgroundTask.startedAt)) / 1000)))}
                                  </span>
                                )}
                                {stateBarBackgroundTask.lastOutputAt != null && (
                                  <span className={styles.stateBarElapsed}>
                                    · last output {formatElapsed(Math.max(0, Math.floor((Date.now() - stateBarBackgroundTask.lastOutputAt) / 1000)))} ago
                                  </span>
                                )}
                              </>
                            )}
                            {stateBarScheduledAt && selectedSession.scheduledWakeupReason && (
                              <span
                                className={styles.stateBarReason}
                                title={selectedSession.scheduledWakeupReason}
                              >
                                {selectedSession.scheduledWakeupReason}
                              </span>
                            )}
                            {stateBarActiveSubagents.length > 0 && (
                              <span className={styles.stateBarDelegate}>
                                · {stateBarActiveSubagents.length} delegated
                              </span>
                            )}
                            <div style={{flex: 1}} />
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
                                        body: JSON.stringify({ text: '\x1b', raw: true }),
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
                                        body: JSON.stringify({ text: '\x03', raw: true }),
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
                              isLimitPrompt={selectedSession.isLimitPrompt}
                              styles={styles}
                            />
                          )}
                          {/* Pending AskUserQuestion now renders inline in the feed
                              (see FeedSegments question segment), not as a floating overlay. */}
                        </>
                      )}
                      {selectedSession.ideName && selectedSession.sessionType !== 'bridge' && selectedSession.sessionType !== 'embedded' && (
                        <div className={styles.ideInjectNotice}>
                          <span>
                            Injection unavailable — run{' '}
                            <code>{platform === 'win32' ? 'overlord-bridge.exe -- claude' : 'overlord-bridge -- claude'}</code>
                            {' '}in your IDE terminal to enable sending.
                          </span>
                        </div>
                      )}
                      <div className={`${styles.sendArea} ${needsResume ? styles.sendAreaClosed : ''} ${selectedSession.ideName && selectedSession.sessionType !== 'bridge' && selectedSession.sessionType !== 'embedded' ? styles.sendAreaDisabled : ''}`}>
                        {sessionError && (
                          <div className={styles.sendError}>{sessionError}</div>
                        )}
                        {pastedImage && (
                          <div className={styles.imagePreview}>
                            <img src={pastedImage.previewUrl} alt="pasted" className={styles.imagePreviewImg} />
                            <button className={styles.imageRemoveBtn} onClick={() => setPastedImage(null)}>✕</button>
                          </div>
                        )}
                        <div className={styles.sendInputWrapper}>
                          <div className={styles.quickMenuAnchor} ref={quickMenuRef}>
                            <button
                              className={styles.quickMenuTrigger}
                              title="Quick prompts"
                              onClick={() => setShowQuickMenu(v => !v)}
                            >
                              <span className={styles.burgerIcon} />
                            </button>
                            {showQuickMenu && (
                              <div className={styles.quickMenu}>
                                {QUICK_PROMPTS.map(p => (
                                  <button
                                    key={p.id}
                                    className={styles.quickMenuItem}
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      setShowQuickMenu(false);
                                      sendText(p.body);
                                    }}
                                  >
                                    {p.label}
                                  </button>
                                ))}
                                <div className={styles.quickMenuDivider} />
                                <button
                                  className={styles.quickMenuItem}
                                  onMouseDown={e => {
                                    e.preventDefault();
                                    setShowQuickMenu(false);
                                    setShowSkillPicker(true);
                                  }}
                                >
                                  Skill…
                                </button>
                                <button
                                  className={styles.quickMenuItem}
                                  disabled={sentHistory.length === 0}
                                  onMouseDown={e => {
                                    e.preventDefault();
                                    if (sentHistory.length === 0) return;
                                    setShowQuickMenu(false);
                                    setShowHistoryMenu(true);
                                  }}
                                >
                                  Recent sends…
                                </button>
                              </div>
                            )}
                            {showHistoryMenu && (
                              <div className={`${styles.quickMenu} ${styles.historyMenu}`}>
                                {recentSends.map((entry, i) => (
                                  <button
                                    key={`${entry.ts}-${i}`}
                                    className={`${styles.quickMenuItem} ${styles.historyItem}`}
                                    title={entry.text}
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      setShowHistoryMenu(false);
                                      recallEntry(i);
                                    }}
                                  >
                                    <span className={styles.historyItemText}>{entry.text.replace(/\s+/g, ' ').trim()}</span>
                                    <span className={styles.historyItemTime}>{formatParkedAge(entry.ts)}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <textarea
                            ref={sendTextareaRef}
                            className={`${styles.sendTextarea} ${needsResume ? styles.sendTextareaClosed : ''} ${resuming ? styles.sendTextareaResuming : ''}`}
                            value={sendInput2}
                            disabled={!connected || !!(selectedSession.ideName && selectedSession.sessionType !== 'bridge' && selectedSession.sessionType !== 'embedded')}
                            onChange={e => {
                              setSendInput2(e.target.value);
                              // Editing a recalled message makes it a normal draft again.
                              if (historyIndex !== null) { setHistoryIndex(null); preHistoryDraft.current = ''; }
                              // Persist every keystroke so unsent text survives reload/crash.
                              saveDraft(effectiveOvrId, e.target.value);
                            }}
                            onClick={() => {
                              if (needsResume && onResumeSession && !resuming) {
                                setResuming(true);
                                onResumeSession(selectedSession.sessionId, selectedSession.cwd);
                              }
                            }}
                            onKeyDown={e => {
                              if (selectedSession.ideName && selectedSession.sessionType !== 'bridge' && selectedSession.sessionType !== 'embedded') { e.preventDefault(); return; }
                              if (needsResume) {
                                e.preventDefault();
                                if (onResumeSession && !resuming) { setResuming(true); onResumeSession(selectedSession.sessionId, selectedSession.cwd); }
                                return;
                              }
                              // ↑/↓ walk the sent-message ring, shell-style. Only from an
                              // empty composer (or once already navigating) so ↑ keeps
                              // moving the caret inside a multi-line draft.
                              const el = e.currentTarget;
                              const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0;
                              if (e.key === 'ArrowUp' && sentHistory.length > 0 &&
                                  (historyIndex !== null || sendInput2 === '' || caretAtStart)) {
                                e.preventDefault();
                                recallEntry(Math.min((historyIndex ?? -1) + 1, sentHistory.length - 1));
                                return;
                              }
                              if (e.key === 'ArrowDown' && historyIndex !== null) {
                                e.preventDefault();
                                if (historyIndex === 0) exitHistory(true);
                                else recallEntry(historyIndex - 1);
                                return;
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                // Empty composer + busy session → forward Esc as an
                                // interrupt, TUI-style. Non-empty composer keeps the
                                // clear-draft behavior.
                                if (sendInput2 === '' && historyIndex === null &&
                                    (selectedSession.state === 'working' || selectedSession.state === 'thinking')) {
                                  fetch(`/api/sessions/${selectedSession.sessionId}/inject`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ text: '\x1b', raw: true }),
                                  }).catch(err => console.error('Interrupt failed:', err));
                                  return;
                                }
                                // Always clears — including a recalled history entry.
                                setHistoryIndex(null);
                                preHistoryDraft.current = '';
                                setSendInput2('');
                                clearDraft(effectiveOvrId);
                              } else if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (!connected) return;
                                const text = sendInput2.trim();
                                if (!text && !pastedImage) {
                                  // bare Enter — send \r to confirm a prompt (e.g. permission dialog)
                                  injectText(effectiveOvrId, '\r', false);
                                  return;
                                }
                                handleSend();
                              }
                            }}
                            onPaste={async e => {
                              if (needsResume) {
                                e.preventDefault();
                                if (onResumeSession && !resuming) { setResuming(true); onResumeSession(selectedSession.sessionId, selectedSession.cwd); }
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
                            placeholder={resuming ? 'Resuming session…' : (selectedSession.isArchived ? 'Archived — click to unarchive & resume' : (needsResume ? (selectedSession.state === 'closed' ? 'Session exited — click to resume' : 'PTY disconnected — click to resume') : (connected ? (sentHistory.length > 0 ? 'Message… (Enter to send, ↑ for history)' : 'Message… (Enter to send, paste image)') : 'Not connected')))}
                            rows={2}
                          />
                          <button
                            className={styles.sendButton}
                            onClick={() => {
                              if (needsResume) {
                                if (onResumeSession && !resuming) { setResuming(true); onResumeSession(selectedSession.sessionId, selectedSession.cwd); }
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

                {/* Tab: Terminal — always mounted when live to preserve scrollback buffer */}
                {(isPty || isBridgeSession?.(effectiveOvrId)) && (
                  <div
                    className={styles.terminalContent}
                    style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
                  >
                    <XtermTerminal
                      sessionId={effectiveOvrId}
                      onInput={(data) => sendInput(effectiveOvrId, data)}
                      onResize={(cols, rows) => resizePty(effectiveOvrId, cols, rows)}
                      registerOutputHandler={registerOutputHandler}
                      isExited={isExited && !isPty}
                      onResume={
                        onResumeSession
                          ? () => onResumeSession(selectedSession.sessionId, selectedSession.cwd)
                          : undefined
                      }
                      fillHeight
                      isBridge={isBridgeSession?.(effectiveOvrId)}
                    />
                  </div>
                )}
                {activeTab === 'terminal' && !isPty && !isBridgeSession?.(effectiveOvrId) && selectedSession.sessionType === 'embedded' && (
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
                )}

                {/* Tab: Notes — free-form session description. First line also renders
                    inline in the header and on the worker card. */}
                {activeTab === 'notes' && (
                  <div className={styles.notesTab}>
                    <textarea
                      className={styles.notesTextarea}
                      value={notesContent}
                      placeholder="Describe this session…"
                      onChange={e => {
                        const value = e.target.value;
                        setNotesContent(value);
                        if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current);
                        const sessionId = selectedSession.sessionId;
                        notesSaveTimerRef.current = setTimeout(() => {
                          fetch(`/api/sessions/${sessionId}/notes`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ notes: value }),
                          }).then(() => {
                            updateNoteFirstLine(sessionId, value);
                          }).catch(() => {});
                        }, 500);
                      }}
                    />
                  </div>
                )}

                {/* Tab: Details */}
                {activeTab === 'details' && (
                  <div className={styles.scrollArea}>
                    {selectedSession.scheduledWakeupAt != null && (
                      <section className={styles.section}>
                        <ScheduledWakeupsStats
                          sessionId={selectedSession.sessionId}
                          nextFireAt={selectedSession.scheduledWakeupAt}
                          reason={selectedSession.scheduledWakeupReason}
                        />
                      </section>
                    )}
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
                      {selectedSession.overlordId && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Ovr ID</span>
                          <span className={styles.fieldValue} title={selectedSession.overlordId} style={{ fontFamily: 'monospace', fontSize: '0.8em', opacity: 0.7 }}>
                            {selectedSession.overlordId}
                            <button
                              className={styles.copyIdButton}
                              title="Copy overlord ID"
                              onClick={() => { void navigator.clipboard.writeText(selectedSession.overlordId!); }}
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <rect x="4.5" y="1.5" width="6" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                                <path d="M7.5 1.5V1a.5.5 0 0 0-.5-.5H2A1 1 0 0 0 1 1.5V9a.5.5 0 0 0 .5.5H3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                              </svg>
                            </button>
                          </span>
                        </div>
                      )}
                      {selectedSession.sessionHistory && selectedSession.sessionHistory.length > 0 && (
                        <div className={styles.field} style={{ alignItems: 'flex-start' }}>
                          <span className={styles.fieldLabel} style={{ paddingTop: '2px' }}>Lineage</span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1 }}>
                            {selectedSession.sessionHistory.map((entry, i) => {
                              const d = new Date(entry.attachedAt);
                              const ts = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                              const isCurrent = entry.sessionId === selectedSession.sessionId;
                              return (
                                <div key={entry.sessionId} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'monospace', fontSize: '0.75em' }}>
                                  <span style={{ opacity: 0.4, width: '80px', flexShrink: 0 }}>{ts}</span>
                                  <span style={{ opacity: isCurrent ? 1 : 0.5, color: isCurrent ? 'var(--color-accent, #a78bfa)' : undefined }}>
                                    {entry.sessionId.slice(0, 8)}
                                  </span>
                                  {i === selectedSession.sessionHistory!.length - 1 && (
                                    <span style={{ opacity: 0.4, fontSize: '0.9em' }}>← current</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
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
                      {selectedSession.provider && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Assistant</span>
                          <span
                            className={`${styles.assistantPill} ${assistantPillClass(selectedSession.provider, styles)}`}
                          >
                            {assistantDisplayName(selectedSession.provider)}
                          </span>
                        </div>
                      )}
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
                          <span className={styles.fieldValue}>{formatModel(selectedSession.model)}</span>
                        </div>
                      )}
                      {selectedSession.inputTokens !== undefined && (() => {
                        const contextWindow = getContextWindow(selectedSession.model, selectedSession.inputTokens);
                        const pct = Math.min(100, (selectedSession.inputTokens / contextWindow) * 100);
                        const usedK = (selectedSession.inputTokens / 1000).toFixed(0);
                        const totalK = (contextWindow / 1000).toFixed(0);
                        const barColor = selectedSession.color;
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
                      {selectedSession.jiraKeys && selectedSession.jiraKeys.length > 0 && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Tickets</span>
                          <span className={styles.fieldValue}>
                            <JiraChips
                              keys={selectedSession.jiraKeys}
                              baseUrl={jiraBaseUrl}
                              sessionId={selectedSession.sessionId}
                            />
                          </span>
                        </div>
                      )}
                      {selectedSession.prRefs && selectedSession.prRefs.length > 0 && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Pull requests</span>
                          <span className={styles.fieldValue}>
                            <PrChips
                              refs={selectedSession.prRefs}
                              sessionId={selectedSession.sessionId}
                            />
                          </span>
                        </div>
                      )}

                      {selectedSession.skillsUsed && selectedSession.skillsUsed.length > 0 && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>Skills</span>
                          <span className={styles.fieldValue}>
                            <SkillChips skills={selectedSession.skillsUsed} />
                          </span>
                        </div>
                      )}


                      {/* Resume / Connect section */}
                      {(() => {
                        const supportsExternalConnect = selectedSession.provider !== 'opencode';
                        const availableModes = [
                          onResumeSession ? 'overlord' : null,
                          supportsExternalConnect && onOpenInTerminal ? 'terminal' : null,
                          supportsExternalConnect && onOpenBridged ? 'bridged' : null,
                        ].filter(Boolean) as ('overlord' | 'terminal' | 'bridged')[];
                        const effectiveMode = availableModes.includes(connectMode) ? connectMode : (availableModes[0] ?? 'overlord');
                        const isClosed = selectedSession.state === 'closed';
                        const sid = selectedSession.sessionId;
                        const marker = sid.slice(0, 8);
                        const safeName = currentDisplayName.replace(/"/g, '-');
                        const bridgeBin = bridgePath ? `"${bridgePath}"` : 'overlord-bridge';
                        const directCmd = `cd "${selectedSession.cwd}" && claude --resume ${sid} --name "${currentDisplayName}"`;
                        const bridgeCmd = `cd "${selectedSession.cwd}" && ${bridgeBin} --pipe overlord-${marker} -- claude --resume ${sid} --name "${safeName}___BRG:${marker}"`;

                        const modeRows: { key: 'overlord' | 'terminal' | 'bridged'; label: string; cmd: string | null; available: boolean }[] = [
                          { key: 'overlord', label: 'Overlord', cmd: null,       available: !!onResumeSession },
                          { key: 'terminal', label: 'Terminal', cmd: directCmd,  available: !!onOpenInTerminal },
                          { key: 'bridged',  label: 'Bridge',   cmd: bridgeCmd,  available: !!onOpenBridged },
                        ];

                        return (
                          <div className={styles.resumeSection}>
                            {/* Mode rows — type label left, command right */}
                            <div className={styles.resumeModeRows}>
                              {modeRows.filter(r => r.available).map(({ key, label, cmd }) => {
                                const active = effectiveMode === key;
                                return (
                                  <div
                                    key={key}
                                    className={`${styles.resumeModeRow} ${active ? styles.resumeModeRowActive : ''}`}
                                    onClick={() => setConnectMode(key)}
                                  >
                                    <span className={`${styles.resumeModeRowLabel} ${active ? styles.resumeModeRowLabelActive : ''}`}>{label}</span>
                                    {cmd ? (
                                      <>
                                        <code className={`${styles.resumeModeRowCmd} ${active ? styles.resumeModeRowCmdActive : ''}`}>{cmd}</code>
                                        <button
                                          className={styles.resumeCopyBtn}
                                          onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(cmd); }}
                                          title="Copy"
                                        >
                                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                        </button>
                                      </>
                                    ) : (
                                      <span className={styles.resumeModeRowHint}>Spawns a PTY session managed inside Overlord</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Action row */}
                            <div className={styles.resumeActions}>
                              {effectiveMode === 'overlord' && onResumeSession && (
                                <button
                                  className={`${styles.resumeActionBtn} ${resuming ? styles.resumeButtonPending : ''}`}
                                  disabled={resuming}
                                  onClick={() => { setResuming(true); onResumeSession(sid, selectedSession.cwd); }}
                                >
                                  {resuming ? 'Starting…' : isClosed ? 'Resume in Overlord' : 'Attach in Overlord'}
                                </button>
                              )}
                              {effectiveMode === 'terminal' && onOpenInTerminal && (
                                <button
                                  className={`${styles.resumeActionBtn} ${openingTerminal ? styles.resumeButtonPending : ''}`}
                                  disabled={openingTerminal}
                                  onClick={() => { setOpeningTerminal(true); onOpenInTerminal(sid, selectedSession.cwd); setTimeout(() => setOpeningTerminal(false), 2000); }}
                                >
                                  {openingTerminal ? 'Opening…' : isClosed ? 'Open in Terminal' : 'Attach in Terminal'}
                                </button>
                              )}
                              {effectiveMode === 'bridged' && onOpenBridged && (
                                <button
                                  className={`${styles.resumeActionBtn} ${openingBridged ? styles.resumeButtonPending : ''}`}
                                  disabled={openingBridged}
                                  onClick={() => { setOpeningBridged(true); onOpenBridged(sid, selectedSession.cwd); setTimeout(() => setOpeningBridged(false), 3000); }}
                                >
                                  {openingBridged ? 'Opening…' : isClosed ? 'Open in Bridge' : 'Attach in Bridge'}
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
                                        fetch(`/api/sessions/${sid}/kill-process`, { method: 'POST' })
                                          .catch(console.error)
                                          .finally(() => setKilling(false));
                                      }}
                                    >Kill</button>
                                    <button className={styles.killConfirmNo} onClick={() => setConfirmKill(false)}>Cancel</button>
                                  </div>
                                ) : (
                                  <button
                                    className={`${styles.resumeKillBtn} ${killing ? styles.resumeButtonPending : ''}`}
                                    disabled={killing}
                                    onClick={() => setConfirmKill(true)}
                                  >
                                    {killing ? 'Killing…' : 'Kill Session'}
                                  </button>
                                )
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </section>
                  </div>
                )}

                {/* Tab: Artifacts */}
                {activeTab === 'artifacts' && (
                  <ArtifactsTab overlordId={selectedSession.overlordId ?? effectiveOvrId ?? undefined} />
                )}

                {/* Tab: Subagents */}
                {activeTab === 'subagents' && hasSubagents && (
                  <div className={styles.scrollArea}>
                    <section className={styles.section}>
                      {(() => {
                        const activeSubagents = selectedSession.subagents.filter(s => s.state === 'working' || s.state === 'thinking');
                        const idleSubagents = selectedSession.subagents.filter(s => s.state === 'closed' || s.state === 'waiting');
                        const RECENT_MS = 60 * 60 * 1000;
                        const now = Date.now();
                        const recentIdle = idleSubagents.filter(s => {
                          const t = Date.parse(s.lastActivity);
                          return Number.isFinite(t) && now - t <= RECENT_MS;
                        });
                        const olderIdle = idleSubagents.filter(s => !recentIdle.includes(s));
                        const renderIdleItem = (sub: Subagent) => (
                          <li
                            key={sub.agentId}
                            className={`${styles.subagentItem} ${sub.agentId === selectedSubagentId ? styles.subagentItemSelected : ''}`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => onSelectSession?.(selectedSession, sub.agentId)}
                          >
                            <span className={styles.subagentTreeNub} />
                            <WorkerAvatar sessionId={sub.agentId} color={selectedSession.color} size={28} />
                            <span className={styles.subagentDot} style={{ background: STATE_COLORS[sub.state] }} />
                            <div className={styles.subagentInfo}>
                              <span className={styles.subagentType}>{sub.agentType}</span>
                              <span className={styles.subagentDesc}>{sub.description}</span>
                            </div>
                            <span className={styles.summaryMeta}>{formatRelativeTime(sub.lastActivity)}</span>
                            <StateBadge state={sub.state} />
                            <span className={styles.subagentDoneLabel}>done</span>
                          </li>
                        );
                        return (
                          <>
                            <ul className={styles.subagentList}>
                              {activeSubagents.map((sub) => (
                                <li
                                  key={sub.agentId}
                                  className={`${styles.subagentItem} ${sub.agentId === selectedSubagentId ? styles.subagentItemSelected : ''}`}
                                  style={{ cursor: 'pointer' }}
                                  onClick={() => onSelectSession?.(selectedSession, sub.agentId)}
                                >
                                  <span className={styles.subagentTreeNub} />
                                  <WorkerAvatar sessionId={sub.agentId} color={selectedSession.color} size={28} />
                                  <span className={styles.subagentDot} style={{ background: STATE_COLORS[sub.state] }} />
                                  <div className={styles.subagentInfo}>
                                    <span className={styles.subagentType}>{sub.agentType}</span>
                                    <span className={styles.subagentDesc}>{sub.description}</span>
                                  </div>
                                  <StateBadge state={sub.state} />
                                </li>
                              ))}
                              {recentIdle.map(renderIdleItem)}
                            </ul>
                            {olderIdle.length > 0 && (
                              <>
                                <button className={styles.collapseBtn} onClick={() => setShowIdleSubagents(!showIdleSubagents)}>
                                  {showIdleSubagents ? '▾' : '▸'} {olderIdle.length} older
                                </button>
                                {showIdleSubagents && (
                                  <ul className={styles.subagentList}>
                                    {olderIdle.map(renderIdleItem)}
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
      {fileEditorTarget && (
        <FileEditorOverlay
          path={fileEditorTarget.path}
          line={fileEditorTarget.line}
          cwd={selectedSession?.cwd}
          onClose={() => setFileEditorTarget(null)}
        />
      )}
      {showSkillPicker && selectedSession && (
        <SkillPickerPopup
          cwd={selectedSession.cwd}
          onClose={() => setShowSkillPicker(false)}
          onPick={cmd => {
            setSendInput2(cmd);
            setShowSkillPicker(false);
            requestAnimationFrame(() => {
              const el = sendTextareaRef.current;
              if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
            });
          }}
        />
      )}
      <SelectionMenu containerRef={transcriptRef} onExplain={handleExplain} />
    </>
  );
}
