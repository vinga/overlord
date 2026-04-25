import { useCallback, useEffect, useRef, useState } from 'react';

type JumpLabel = { label: string; depth: number } | null;
type JumpAction = { label: string; depth: number; run: () => void };

interface UseTranscriptScrollArgs {
  // Re-runs auto-scroll on feed change
  feed: unknown;
  subagentFeed: unknown;
  activeTab: string;
  // Triggers force-scroll-to-bottom (user sent a message)
  sendCount: number;
  // Whether a search/scroll target is active — when user scrolls to bottom, callback fires
  hasScrollTarget: boolean;
  onReachedBottomWithTarget?: () => void;
}

export function useTranscriptScroll({
  feed,
  subagentFeed,
  activeTab,
  sendCount,
  hasScrollTarget,
  onReachedBottomWithTarget,
}: UseTranscriptScrollArgs) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // When the user initiates an up-jump, lock out auto-scroll-to-bottom for a short
  // window. The smooth-scroll animation starts from scrollTop ≈ bottom, so the first
  // few scroll frames would otherwise re-mark us as "at bottom" and let the feed
  // autoscroll effect hijack the scroll back to MAX_SAFE_INTEGER.
  const autoScrollLockUntilRef = useRef(0);
  const [scrollJumpLabels, setScrollJumpLabels] = useState<{ up: JumpLabel; down: JumpLabel }>({ up: null, down: null });

  const onReachedBottomRef = useRef(onReachedBottomWithTarget);
  onReachedBottomRef.current = onReachedBottomWithTarget;
  const hasScrollTargetRef = useRef(hasScrollTarget);
  hasScrollTargetRef.current = hasScrollTarget;

  function countScopeDepth(targetEl: HTMLElement | null, outer: HTMLElement): number {
    if (!targetEl || targetEl === outer) return 0;
    let depth = 0;
    let cur: HTMLElement | null = targetEl;
    while (cur && cur !== outer) {
      const cls = cur.className;
      if (typeof cls === 'string' && (cls.includes('inlineAgentFeed') || cls.includes('transcriptBubble'))) {
        depth++;
      }
      cur = cur.parentElement;
    }
    return depth;
  }

  function findLongBubbleAtCenter(outer: HTMLElement): HTMLElement | null {
    const outerRect = outer.getBoundingClientRect();
    const targetY = outerRect.top + outerRect.height / 2;
    const minHeight = outer.clientHeight * 1.5;
    const bubbles = outer.querySelectorAll<HTMLElement>('[class*="transcriptBubble"]');
    let best: HTMLElement | null = null;
    for (const b of bubbles) {
      const r = b.getBoundingClientRect();
      if (r.height < minHeight) continue;
      if (r.top <= targetY && r.bottom >= targetY) {
        if (!best || best.contains(b)) best = b;
      }
    }
    return best;
  }

  function findAgentBlockAtCenter(outer: HTMLElement): HTMLElement | null {
    const blocks = outer.querySelectorAll<HTMLElement>('[class*="inlineAgentFeed"]');
    const outerRect = outer.getBoundingClientRect();
    const targetY = outerRect.top + outerRect.height / 2;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.top <= targetY && r.bottom >= targetY) return b;
    }
    return null;
  }

  function scrollElement(el: HTMLElement, top: number) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) el.scrollTop = top;
    else el.scrollTo({ top, behavior: 'smooth' });
  }

  function computeJumps(): { up: JumpAction | null; down: JumpAction | null } {
    const outer = transcriptRef.current;
    if (!outer) return { up: null, down: null };
    const outerScrollable = outer.scrollHeight - outer.clientHeight;
    if (outerScrollable < 16) return { up: null, down: null };

    const outerEl: HTMLElement = outer;
    const bubble = findLongBubbleAtCenter(outerEl);
    const agentBlock = findAgentBlockAtCenter(outerEl);
    const room = 200;
    const outerRect = outerEl.getBoundingClientRect();

    function topInOuter(el: HTMLElement) {
      return el.getBoundingClientRect().top - outerRect.top + outerEl.scrollTop;
    }
    function bottomInOuter(el: HTMLElement) {
      return el.getBoundingClientRect().bottom - outerRect.top + outerEl.scrollTop;
    }

    let up: JumpAction | null = null;
    let down: JumpAction | null = null;

    const upExtra = 100;
    if (bubble) {
      const bTop = topInOuter(bubble);
      if (outer.scrollTop - bTop >= room) {
        up = { label: 'Bubble top', depth: countScopeDepth(bubble, outerEl), run: () => scrollElement(outer, Math.max(0, bTop - 8 - upExtra)) };
      }
    }
    if (!up && agentBlock) {
      const aTop = topInOuter(agentBlock);
      if (outer.scrollTop - aTop >= room) {
        up = { label: 'Agent start', depth: countScopeDepth(agentBlock, outerEl), run: () => scrollElement(outer, Math.max(0, aTop - 8 - upExtra)) };
      }
    }
    if (!up && outerEl.scrollTop >= 64) {
      up = { label: 'Session top', depth: 0, run: () => scrollElement(outerEl, 0) };
    }

    const viewBottom = outer.scrollTop + outer.clientHeight;
    if (bubble) {
      const bBot = bottomInOuter(bubble);
      if (bBot - viewBottom >= room) {
        down = { label: 'Bubble bottom', depth: countScopeDepth(bubble, outerEl), run: () => scrollElement(outer, bBot - outer.clientHeight + 8) };
      }
    }
    if (!down && agentBlock) {
      const aBot = bottomInOuter(agentBlock);
      if (aBot - viewBottom >= room) {
        down = { label: 'Agent end', depth: countScopeDepth(agentBlock, outerEl), run: () => scrollElement(outer, aBot - outer.clientHeight + 8) };
      }
    }
    if (!down && outer.scrollHeight - viewBottom >= Math.min(room, 64)) {
      down = { label: 'Session latest', depth: 0, run: () => scrollElement(outer, outer.scrollHeight) };
    }

    return { up, down };
  }

  const recomputeJump = useCallback(() => {
    const { up, down } = computeJumps();
    setScrollJumpLabels(prev => {
      const upNext = up ? { label: up.label, depth: up.depth } : null;
      const downNext = down ? { label: down.label, depth: down.depth } : null;
      if (prev.up?.label === upNext?.label && prev.up?.depth === upNext?.depth &&
          prev.down?.label === downNext?.label && prev.down?.depth === downNext?.depth) return prev;
      return { up: upNext, down: downNext };
    });
  }, []);

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const threshold = 40;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    if (!(atBottom && Date.now() < autoScrollLockUntilRef.current)) {
      isAtBottomRef.current = atBottom;
    }
    if (atBottom && hasScrollTargetRef.current) onReachedBottomRef.current?.();
    recomputeJump();
  }, [recomputeJump]);

  const handleScrollJumpUp = useCallback(() => {
    const { up } = computeJumps();
    if (!up) return;
    // Disengage auto-scroll-to-bottom and lock it out for the duration of the
    // smooth-scroll animation. Without the lock, the first scroll frames still
    // register as "at bottom" (< 40px moved) and feed updates mid-animation
    // would snap scrollTop back to MAX_SAFE_INTEGER.
    isAtBottomRef.current = false;
    autoScrollLockUntilRef.current = Date.now() + 1000;
    up.run();
  }, []);

  const handleScrollJumpDown = useCallback(() => {
    const { down } = computeJumps();
    if (!down) return;
    if (down.label === 'Session latest') isAtBottomRef.current = true;
    down.run();
  }, []);

  const scrollToBottom = useCallback(() => {
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
    return () => cancelAnimationFrame(raf1);
  }, []);

  // Auto-scroll when feed changes, only if already at bottom
  useEffect(() => {
    if (Date.now() < autoScrollLockUntilRef.current) return;
    if (!isAtBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [feed, subagentFeed, activeTab]);

  // Force scroll to bottom when user sends a message
  useEffect(() => {
    if (sendCount === 0) return;
    isAtBottomRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (transcriptRef.current) {
          transcriptRef.current.scrollTop = Number.MAX_SAFE_INTEGER;
        }
      });
    });
  }, [sendCount]);

  return {
    transcriptRef,
    isAtBottomRef,
    scrollJumpLabels,
    handleTranscriptScroll,
    handleScrollJumpUp,
    handleScrollJumpDown,
    recomputeJump,
    scrollToBottom,
  };
}
