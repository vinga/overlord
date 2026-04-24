import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { marked } from 'marked';
import styles from './WorkerArtifactPill.module.css';

const planMarkdownCache = new Map<string, string>();
function renderPlanMarkdown(text: string): string {
  const cached = planMarkdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { breaks: true, async: false }) as string;
  if (planMarkdownCache.size > 200) planMarkdownCache.clear();
  planMarkdownCache.set(text, html);
  return html;
}

type PlanStatus = 'draft' | 'active' | 'done' | 'archived';

interface Props {
  artifactId: string;
  title: string;
  planContent: string;
  planStatus: PlanStatus;
  timestamp: string;
}

const STATUS_OPTIONS: PlanStatus[] = ['draft', 'active', 'done', 'archived'];

const TITLE_MAX = 48;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function statusLabel(s: PlanStatus): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusPillClass(s: PlanStatus): string {
  if (s === 'active')   return styles.statusPillActive;
  if (s === 'done')     return styles.statusPillDone;
  if (s === 'archived') return styles.statusPillArchived;
  return styles.statusPillDraft;
}

export function WorkerArtifactPill({ artifactId, title, planContent, planStatus, timestamp }: Props) {
  const [pinned, setPinned] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<PlanStatus | null>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  const currentStatus = pendingStatus ?? planStatus;

  useEffect(() => {
    if (pendingStatus && planStatus === pendingStatus) setPendingStatus(null);
  }, [planStatus, pendingStatus]);

  const changeStatus = async (next: PlanStatus) => {
    setMenuOpen(false);
    if (next === currentStatus) return;
    setPendingStatus(next);
    try {
      const r = await fetch(`/api/artifacts/${artifactId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      console.error('Failed to update plan status', err);
      setPendingStatus(null);
    }
  };

  const open = pinned;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (popoverRef.current?.contains(t)) return;
      if (pillRef.current?.contains(t)) return;
      setMenuOpen(false);
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuOpen(false); setPinned(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const el = popoverRef.current;
    if (!el) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = el.getBoundingClientRect();
    const anchorCenter = anchor.left + anchor.width / 2;
    let left = anchorCenter - width / 2;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    const spaceBelow = vh - anchor.bottom;
    const top = spaceBelow >= height + margin + 6 || spaceBelow >= vh / 2
      ? anchor.bottom + 6
      : Math.max(margin, anchor.top - height - 6);
    setPos({ left, top });
  }, [open, anchor]);

  const handleClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget.getBoundingClientRect());
    setPos(null);
    setPinned(p => !p);
  };

  return (
    <span className={styles.wrap}>
      <span
        ref={pillRef}
        className={styles.pill}
        onClick={handleClick}
        title={title}
      >
        <PlanIcon className={styles.icon} />
        <span className={styles.title}>{title}</span>
      </span>
      {open && ReactDOM.createPortal(
        <div
          ref={popoverRef}
          className={`${styles.popover} ${pinned ? styles.popoverPinned : ''}`}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.popoverHeader}>
            <div className={styles.statusMenuWrap} ref={statusMenuRef}>
              <button
                type="button"
                className={`${styles.statusPill} ${styles.statusPillButton} ${statusPillClass(currentStatus)}`}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
                title="Change status"
              >
                {statusLabel(currentStatus)}
                <span className={styles.statusCaret}>▾</span>
              </button>
              {menuOpen && (
                <div className={styles.statusMenu} onClick={(e) => e.stopPropagation()}>
                  {STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      type="button"
                      className={`${styles.statusMenuItem} ${opt === currentStatus ? styles.statusMenuItemActive : ''}`}
                      onClick={() => changeStatus(opt)}
                    >
                      <span className={`${styles.statusDot} ${styles['statusDot_' + opt]}`} />
                      {statusLabel(opt)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className={styles.popoverTitle}>{title}</span>
            <span className={styles.popoverTime}>{relativeTime(timestamp)}</span>
          </div>
          <div
            className={`${styles.popoverBody} ${styles.planBody}`}
            dangerouslySetInnerHTML={{ __html: renderPlanMarkdown(planContent) }}
          />
        </div>,
        document.body
      )}
    </span>
  );
}

function PlanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
      <path d="M5.5 6h5" />
      <path d="M5.5 9h5" />
      <path d="M5.5 12h3" />
    </svg>
  );
}
