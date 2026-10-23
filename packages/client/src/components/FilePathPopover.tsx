import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { revealRoomFile } from './RoomFilesPanel';
import styles from './FilePathPopover.module.css';

// Hover card for the `[data-file-path]` spans the feed renders. The server
// resolves the token (absolute, `~/`, or relative to room / git root / $HOME /
// other rooms) and checks existence; every hit is its own row with Open and
// Reveal. Owns clicks on those spans too: one openable hit opens straight away,
// anything else pins the card so the user can choose.

interface Candidate {
  path: string;
  kind: 'file' | 'dir';
  base: string;
  openable: boolean;
  /** inTree false → the room's Files tree does not list it; `reason` says why. */
  room?: { cwd: string; rel: string; inTree?: boolean; reason?: string };
  preview?: string;
  size?: number;
}

interface Props {
  cwd?: string;
  platform?: string;
  onOpen: (target: { path: string; line?: number }) => void;
}

interface Shown {
  anchor: HTMLElement;
  raw: string;
  line?: number;
  candidates: Candidate[] | null;
  error?: string;
  pinned: boolean;
}

const HOVER_DELAY_MS = 350;
const HIDE_DELAY_MS = 200;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; candidates: Candidate[] }>();
// For `~/…` display only; filled from the first resolve response.
let homeDir: string | null = null;

async function resolveCandidates(raw: string, cwd: string | undefined): Promise<Candidate[]> {
  const key = `${cwd ?? ''}\0${raw}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candidates;
  const res = await fetch('/api/resolve-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: raw, cwd }),
  });
  if (!res.ok) throw new Error(`resolve failed (${res.status})`);
  const { candidates, home } = await res.json() as { candidates: Candidate[]; home?: string };
  if (home) homeDir = home;
  cache.set(key, { at: Date.now(), candidates });
  return candidates;
}

function readAnchor(el: HTMLElement): { raw: string; line?: number } | null {
  const raw = el.getAttribute('data-file-path');
  if (!raw) return null;
  const lineAttr = el.getAttribute('data-file-line');
  const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
  return { raw, line: Number.isFinite(line) ? line : undefined };
}

function tildify(path: string, home: string | null): string {
  return home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

export function FilePathPopover({ cwd, platform = 'darwin', onOpen }: Props) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;

  const clearTimers = () => {
    if (showTimer.current) { window.clearTimeout(showTimer.current); showTimer.current = null; }
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  };

  const markMissing = (anchor: HTMLElement, candidates: Candidate[]) => {
    anchor.classList.toggle('inlineFilePathMissing', candidates.length === 0);
  };

  const show = useCallback((anchor: HTMLElement, pinned: boolean) => {
    const a = readAnchor(anchor);
    if (!a) return;
    setRevealed(null);
    setActive(0);
    setShown({ anchor, raw: a.raw, line: a.line, candidates: null, pinned });
    resolveCandidates(a.raw, cwd)
      .then((candidates) => {
        markMissing(anchor, candidates);
        setShown((s) => (s && s.anchor === anchor ? { ...s, candidates } : s));
      })
      .catch((err: Error) => {
        setShown((s) => (s && s.anchor === anchor ? { ...s, candidates: [], error: err.message } : s));
      });
  }, [cwd]);

  useEffect(() => {
    const anchorOf = (t: EventTarget | null) =>
      (t as HTMLElement | null)?.closest?.('[data-file-path]') as HTMLElement | null;

    const over = (e: MouseEvent) => {
      const anchor = anchorOf(e.target);
      if (!anchor) return;
      if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
      const cur = shownRef.current;
      if (cur?.anchor === anchor || cur?.pinned) return;
      if (showTimer.current) window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => show(anchor, false), HOVER_DELAY_MS);
    };
    const out = (e: MouseEvent) => {
      const anchor = anchorOf(e.target);
      if (!anchor) return;
      if (showTimer.current) { window.clearTimeout(showTimer.current); showTimer.current = null; }
      const into = e.relatedTarget as Node | null;
      if (into && (anchor.contains(into) || cardRef.current?.contains(into))) return;
      if (shownRef.current && !shownRef.current.pinned) {
        hideTimer.current = window.setTimeout(() => setShown(null), HIDE_DELAY_MS);
      }
    };
    const click = (e: MouseEvent) => {
      const anchor = anchorOf(e.target);
      if (!anchor) {
        if (shownRef.current && !cardRef.current?.contains(e.target as Node)) setShown(null);
        return;
      }
      e.preventDefault();
      clearTimers();
      const a = readAnchor(anchor);
      if (!a) return;
      resolveCandidates(a.raw, cwd)
        .then((candidates) => {
          markMissing(anchor, candidates);
          if (candidates.length === 1 && candidates[0].openable) {
            setShown(null);
            onOpen({ path: candidates[0].path, line: a.line });
          } else {
            show(anchor, true);
          }
        })
        .catch(() => show(anchor, true));
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setShown(null); };
    const scroll = () => { if (shownRef.current && !shownRef.current.pinned) setShown(null); };

    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('click', click);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true);
    return () => {
      clearTimers();
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [cwd, onOpen, show]);

  // Anchor gone (feed re-rendered) → card goes too.
  useEffect(() => {
    if (shown && !shown.anchor.isConnected) setShown(null);
  });

  if (!shown || !shown.anchor.isConnected) return null;

  const rect = shown.anchor.getBoundingClientRect();
  const width = 460;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = window.innerHeight - rect.bottom > 320;
  const pos = below
    ? { top: rect.bottom + 6, left }
    : { bottom: window.innerHeight - rect.top + 6, left };

  const revealLabel = platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in folder';
  const candidates = shown.candidates ?? [];
  const current = candidates[Math.min(active, candidates.length - 1)];

  const reveal = (path: string) => {
    void fetch('/api/reveal-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => { if (r.ok) setRevealed(path); });
  };

  return createPortal(
    <div
      ref={cardRef}
      className={styles.card}
      style={{ ...pos, width }}
      role="dialog"
      aria-label={`File ${shown.raw}`}
      onMouseEnter={() => { if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; } }}
      onMouseLeave={() => { if (!shown.pinned) hideTimer.current = window.setTimeout(() => setShown(null), HIDE_DELAY_MS); }}
    >
      <div className={styles.header}>
        <span className={styles.raw} title={shown.raw}>{shown.raw}{shown.line !== undefined ? `:${shown.line}` : ''}</span>
        {candidates.length > 1 && <span className={styles.count}>{candidates.length} matches</span>}
      </div>
      {shown.candidates === null && <div className={styles.status}>Resolving…</div>}
      {shown.candidates?.length === 0 && (
        <div className={styles.status}>{shown.error ?? 'Not found in this room, its git root, home, or other rooms'}</div>
      )}
      {candidates.length > 1 && candidates.map((c, i) => (
        <button
          key={c.path}
          type="button"
          className={`${styles.row} ${c === current ? styles.rowActive : ''}`}
          onMouseEnter={() => setActive(i)}
          onFocus={() => setActive(i)}
          onClick={() => setActive(i)}
        >
          <span className={styles.path} title={c.path}>{tildify(c.path, homeDir)}</span>
          <span className={styles.meta}>
            <span className={styles.badge}>{c.kind === 'dir' ? 'folder' : 'file'}</span>
            <span>{c.base}</span>
          </span>
        </button>
      ))}
      {current && (
        <>
          {candidates.length === 1 && (
            <div className={styles.single}>
              <span className={styles.path} title={current.path}>{tildify(current.path, homeDir)}</span>
              <span className={styles.meta}>
                <span className={styles.badge}>{current.kind === 'dir' ? 'folder' : 'file'}</span>
                {current.size !== undefined && <span>{formatSize(current.size)}</span>}
              </span>
            </div>
          )}
          {current.preview !== undefined && (
            <pre className={styles.preview}>{current.preview || <span className={styles.empty}>(empty file)</span>}</pre>
          )}
          <div className={styles.actions}>
            {current.openable && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => { setShown(null); onOpen({ path: current.path, line: shown.line }); }}
              >
                Open
              </button>
            )}
            {current.room && current.kind === 'file' && (
              <button
                type="button"
                className={styles.btn}
                disabled={!current.room.inTree}
                title={current.room.inTree ? `Select ${current.room.rel} in the room's file tree` : `Not in Files: ${current.room.reason}`}
                onClick={() => { setShown(null); revealRoomFile(current.room!.cwd, current.room!.rel); }}
              >
                Show in Files
              </button>
            )}
            <button type="button" className={styles.btn} onClick={() => reveal(current.path)}>
              {revealed === current.path ? 'Revealed ✓' : revealLabel}
            </button>
          </div>
          {current.kind === 'file' && !current.openable && (
            <div className={styles.hint}>No preview — outside every room, or looks like a secret</div>
          )}
          {current.room && current.kind === 'file' && current.openable && !current.room.inTree && (
            <div className={styles.hint}>Not shown in Files — {current.room.reason}</div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
