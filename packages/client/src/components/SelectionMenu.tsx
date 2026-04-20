import React, { useEffect, useRef, useState, RefObject, useCallback } from 'react';
import styles from './SelectionMenu.module.css';

interface Props {
  containerRef: RefObject<HTMLElement | null>;
  onExplain: (quotedText: string) => void;
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

export function SelectionMenu({ containerRef, onExplain }: Props): React.JSX.Element | null {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [quoted, setQuoted] = useState<string>('');
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
    const estWidth = 96;
    left = Math.max(VIEWPORT_PAD + estWidth / 2, Math.min(vw - VIEWPORT_PAD - estWidth / 2, left));

    setQuoted(quoteSelection(text));
    setPos({ top, left, above });
  }, [containerRef]);

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
    </div>
  );
}
