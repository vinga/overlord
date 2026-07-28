import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WORKER_ICONS, type WorkerIcon } from '../types';
import { WorkerAvatar } from './WorkerAvatar';
import { WorkerGlyph } from './workerGlyphs';
import styles from './ColorPicker.module.css';

const POPOVER_WIDTH = 264; // matches .popover min-width + padding
const POPOVER_HEIGHT = 300; // approximate; used only for vertical flip

// Keyed by WorkerIcon, so adding a glyph to WORKER_ICONS fails the build here
// until it gets a label — the picker can never silently lag the icon list.
const ICON_LABELS: Record<WorkerIcon, string> = {
  user: 'Worker',
  dashboard: 'Dashboard',
  ticket: 'Refining ticket',
  investigate: 'Investigating',
  teach: 'Teaching',
  notes: 'Pinned notes',
  btw: 'By the way',
  release: 'Release',
};

const ICON_PRESETS: { icon: WorkerIcon; label: string }[] =
  WORKER_ICONS.map(icon => ({ icon, label: ICON_LABELS[icon] }));

const HUE_PRESETS: { label: string; h: number; s?: number }[] = [
  { label: 'Red', h: 0 },
  { label: 'Orange', h: 30 },
  { label: 'Yellow', h: 52 },
  { label: 'Green', h: 130 },
  { label: 'Teal', h: 175 },
  { label: 'Blue', h: 210 },
  { label: 'Purple', h: 280 },
  { label: 'Pink', h: 340 },
  { label: 'Grey', h: 0, s: 0 },
];

const LIGHT_PRESETS: { label: string; l: number }[] = [
  { label: 'Dark', l: 35 },
  { label: 'Medium', l: 58 },
  { label: 'Light', l: 80 },
];

const DEFAULT_COLOR = `hsl(30, 75%, 58%)`;

function parseHsl(color: string): { h: number; s: number; l: number } {
  const m = color.match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/);
  if (!m) return { h: 30, s: 75, l: 55 };
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

interface Props {
  sessionId: string;
  color: string;
  size?: number;
  isRaw?: boolean;
  icon?: WorkerIcon;
  onChange: (color: string) => void;
  onIconChange?: (icon: WorkerIcon) => void;
}

export function ColorPicker({ sessionId, color, size = 44, isRaw = false, icon, onChange, onIconChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [draftHue, setDraftHue] = useState<number | null>(null);
  const latestHueRef = useRef<number | null>(null);

  // Position the portaled popover relative to the avatar button, clamped to the
  // viewport and flipped upward if there's no room below.
  const reposition = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    left = Math.min(left, window.innerWidth - POPOVER_WIDTH - margin);
    left = Math.max(margin, left);
    let top = r.bottom + 10;
    if (top + POPOVER_HEIGHT > window.innerHeight - margin) {
      const above = r.top - 10 - POPOVER_HEIGHT;
      if (above >= margin) top = above;
    }
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    if (open) reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Outside-click closes; the popover is portaled to <body>, so it lives
    // outside wrapperRef — check both the toggle wrapper and the popover.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onReflow = () => reposition();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    latestHueRef.current = null;
    setDraftHue(null);
  }, [color]);

  const parsed = parseHsl(color);
  const hue = draftHue ?? parsed.h;
  const saturation = parsed.s;
  const lightness = parsed.l;

  const emit = (h: number, s: number, l: number) => {
    onChange(`hsl(${h}, ${s}%, ${l}%)`);
    setOpen(false);
  };

  const handleHueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const h = parseFloat(e.target.value);
    latestHueRef.current = h;
    setDraftHue(h);
  };

  const commitHue = () => {
    const h = latestHueRef.current;
    if (h != null && h !== parsed.h) {
      emit(h, saturation, lightness);
    } else {
      latestHueRef.current = null;
      setDraftHue(null);
    }
  };

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.avatarButton}
        onClick={() => setOpen(v => !v)}
        title="Change color"
      >
        <WorkerAvatar sessionId={sessionId} color={color} size={size} isRaw={isRaw} icon={icon} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          role="dialog"
          aria-label="Choose color"
          style={{ top: pos.top, left: pos.left }}
        >
          {onIconChange && (
            <>
              <div className={styles.label}>Icon</div>
              <div className={styles.iconPresets}>
                {ICON_PRESETS.map((p) => {
                  const gradId = `grad-icon-preset-${sessionId}-${p.icon}`;
                  const isSelected = (icon ?? 'user') === p.icon;
                  return (
                    <button
                      key={p.icon}
                      type="button"
                      className={`${styles.iconPreset} ${isSelected ? styles.selected : ''}`}
                      onClick={() => { onIconChange(p.icon); setOpen(false); }}
                      data-label={p.label}
                      aria-label={p.label}
                    >
                      <svg width="24" height="31" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                          <linearGradient id={gradId} x1="0%" y1="0%" x2="60%" y2="100%">
                            <stop offset="0%" stopColor={`hsl(${hue}, ${saturation}%, ${Math.min(100, lightness + 25)}%)`} />
                            <stop offset="100%" stopColor={color} />
                          </linearGradient>
                        </defs>
                        <WorkerGlyph icon={p.icon} gradientUrl={`url(#${gradId})`} color={color} />
                      </svg>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className={styles.label}>Hue</div>
          <div className={styles.presets}>
            {HUE_PRESETS.map((p) => {
              const sat = p.s ?? 75;
              const swatch = `hsl(${p.h}, ${sat}%, ${lightness}%)`;
              const isSelected = p.h === hue && (p.s ?? 75) === saturation;
              return (
                <button
                  key={p.label}
                  type="button"
                  className={`${styles.preset} ${isSelected ? styles.selected : ''}`}
                  style={{ background: swatch }}
                  onClick={() => emit(p.h, sat, lightness)}
                  title={p.label}
                />
              );
            })}
          </div>
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={360}
              value={hue}
              onChange={handleHueChange}
              onPointerUp={commitHue}
              onKeyUp={commitHue}
              onBlur={commitHue}
              className={styles.hueSlider}
            />
          </div>
          <div className={styles.label}>Lightness</div>
          <div className={styles.presetsThree}>
            {LIGHT_PRESETS.map((p) => {
              const swatch = `hsl(${hue}, ${saturation}%, ${p.l}%)`;
              return (
                <button
                  key={p.label}
                  type="button"
                  className={`${styles.preset} ${p.l === lightness ? styles.selected : ''}`}
                  style={{ background: swatch }}
                  onClick={() => emit(hue, saturation, p.l)}
                  title={p.label}
                />
              );
            })}
          </div>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={() => { onChange(DEFAULT_COLOR); setOpen(false); }}
          >
            Reset to default
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
