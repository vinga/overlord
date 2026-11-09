import { useCallback, useEffect, useRef, useState } from 'react';

/** A width the user drags, remembered in localStorage. The handle sits on the
 *  element's LEFT edge: dragging left makes it wider. Returns the width and a
 *  pointerdown handler for the handle. */
export function useResizableWidth(storageKey: string, fallback: number, min: number, max: number) {
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, Math.round(w))), [min, max]);
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return Number.isFinite(v) && v > 0 ? clamp(v) : fallback;
    } catch { return fallback; }
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      latest = clamp(startW + (startX - ev.clientX));
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      try { localStorage.setItem(storageKey, String(latest)); } catch { /* storage blocked */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [clamp, storageKey]);

  // Keep a stored value inside the bounds if they change.
  useEffect(() => { setWidth(w => clamp(w)); }, [clamp]);

  return { width, onPointerDown };
}
