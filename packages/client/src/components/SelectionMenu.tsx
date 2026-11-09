import React, { useEffect, useRef, useState, RefObject, useCallback } from 'react';
import styles from './SelectionMenu.module.css';

interface Props {
  containerRef: RefObject<HTMLElement | null>;
  onExplain: (quotedText: string) => void;
  /** Pin the selected text to the session; resolves to an error or null. */
  onPin?: (text: string) => Promise<string | null>;
}

interface MenuPos {
  top: number;
  left: number;
  above: boolean;
}

const MENU_HEIGHT = 32;
const MENU_MARGIN = 8;
const VIEWPORT_PAD = 8;

function quoteSelection(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  const trimmed = lines.slice(start, end);
  if (trimmed.length === 0) return '';
  return trimmed.map(l => (l.trim() === '' ? '>' : `> ${l}`)).join('\n');
}

function selectionInContainer(sel: Selection, container: HTMLElement): boolean {
  if (sel.rangeCount === 0) return false;
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  if (!anchor || !focus) return false;
  return container.contains(anchor) && container.contains(focus);
}

export function SelectionMenu({ containerRef, onExplain, onPin }: Props): React.JSX.Element | null {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [quoted, setQuoted] = useState<string>('');
  const [raw, setRaw] = useState<string>('');
  const [pinFlash, setPinFlash] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const compute = useCallback(() => {
    const container = containerRef.current;
    if (!container) { setPos(null); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPos(null); return; }
    const text = sel.toString();
    if (!text || !text.trim()) { setPos(null); return; }
    if (!selectionInContainer(sel, container)) { setPos(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { setPos(null); return; }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let above = true;
    let top = rect.top - MENU_HEIGHT - MENU_MARGIN;
    if (top < VIEWPORT_PAD) {
      above = false;
      top = rect.bottom + MENU_MARGIN;
    }
    if (top + MENU_HEIGHT > vh - VIEWPORT_PAD) {
      top = vh - MENU_HEIGHT - VIEWPORT_PAD;
    }

    let left = rect.left + rect.width / 2;
    const estWidth = onPin ? 170 : 96;
    left = Math.max(VIEWPORT_PAD + estWidth / 2, Math.min(vw - VIEWPORT_PAD - estWidth / 2, left));

    setQuoted(quoteSelection(text));
    setRaw(text.trim());
    setPinFlash(null);
    setPos({ top, left, above });
  }, [containerRef, onPin]);

  useEffect(() => {
    function onSelectionChange() {
      compute();
    }
    function onScroll() {
      compute();
    }
    function onResize() {
      compute();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPos(null);
        const sel = window.getSelection();
        sel?.removeAllRanges();
      }
    }
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
    }
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [compute]);

  if (!pos) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (quoted) onExplain(quoted);
    setPos(null);
    const sel = window.getSelection();
    sel?.removeAllRanges();
  };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className={styles.button} onClick={handleClick} title="Ask Claude to explain the selection">
        <span className={styles.glyph}>⌘</span>
        <span className={styles.label}>Explain</span>
      </button>
      {onPin && (
        <button
          type="button"
          className={`${styles.button} ${pinFlash ? styles.buttonDone : ''}`}
          title="Pin the selected text to this session"
          aria-label="Pin selected text"
          onClick={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!raw || pinFlash) return;
            const err = await onPin(raw);
            setPinFlash(err ? 'Not pinned' : 'Pinned');
            setTimeout(() => {
              setPos(null);
              if (!err) window.getSelection()?.removeAllRanges();
            }, err ? 2000 : 700);
          }}
        >
          {pinFlash ? <span className={styles.label}>{pinFlash}</span> : (
            <>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9.5 2.5l4 4-2 1-2.5 2.5-.5 3-1-1L5 8.5l-1-1 3-.5L9.5 4.5z" />
                <line x1="5.2" y1="10.8" x2="2" y2="14" />
              </svg>
              <span className={styles.label}>Pin</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
