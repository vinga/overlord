import { useCallback, useEffect, useRef, useState } from 'react';
import { USER_MSG_SELECTOR } from '../lib/questions';
import styles from './FeedQuestionTicks.module.css';

interface Tick { key: string; top: number; text: string; starred: boolean }

/** Thin marks along the right edge of the feed at your questions and starred
 *  messages (loaded part of the feed). Positions are fractions of the scroll
 *  height, so they line up with the scrollbar; a click scrolls there.
 *  Recomputed when the feed changes or its content resizes — never on scroll. */
export function FeedQuestionTicks({ containerRef, feedKey }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Primitive that changes with the feed (e.g. its length). */
  feedKey: unknown;
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const rafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const c = containerRef.current;
      if (!c || c.scrollHeight <= c.clientHeight) { setTicks(prev => (prev.length ? [] : prev)); return; }
      const base = c.getBoundingClientRect().top - c.scrollTop;
      const next: Tick[] = [];
      for (const el of c.querySelectorAll<HTMLElement>(USER_MSG_SELECTOR.questions)) {
        const y = el.getBoundingClientRect().top - base;
        next.push({
          key: el.getAttribute('data-user-msg') ?? String(y),
          top: Math.min(1, Math.max(0, y / c.scrollHeight)),
          text: el.getAttribute('data-user-text') ?? '',
          starred: el.hasAttribute('data-user-starred'),
        });
      }
      setTicks(prev => (prev.length === next.length && prev.every((t, i) => t.key === next[i].key && Math.abs(t.top - next[i].top) < 0.001 && t.starred === next[i].starred) ? prev : next));
    });
  }, [containerRef]);

  useEffect(() => { measure(); }, [measure, feedKey]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    // The container keeps its size while content grows; watch the content too.
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    for (const child of Array.from(c.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [containerRef, measure, feedKey]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const jump = (key: string) => {
    const c = containerRef.current;
    const el = c?.querySelector<HTMLElement>(`[data-user-msg="${CSS.escape(key)}"]`);
    if (!c || !el) return;
    const offset = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - 8;
    c.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  };

  if (ticks.length === 0) return null;
  return (
    <div className={styles.rail} aria-hidden="true">
      {ticks.map(t => (
        <button
          key={t.key}
          type="button"
          tabIndex={-1}
          className={styles.tick}
          data-starred={t.starred || undefined}
          style={{ top: `${t.top * 100}%` }}
          title={t.text}
          onClick={() => jump(t.key)}
        />
      ))}
    </div>
  );
}
