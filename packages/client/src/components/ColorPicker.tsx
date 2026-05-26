import React, { useEffect, useRef, useState } from 'react';
import { WorkerAvatar } from './WorkerAvatar';
import styles from './ColorPicker.module.css';

const HUE_PRESETS: { label: string; h: number; s?: number }[] = [
  { label: 'Red', h: 0 },
  { label: 'Orange', h: 30 },
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
  onChange: (color: string) => void;
}

export function ColorPicker({ sessionId, color, size = 44, isRaw = false, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [draftHue, setDraftHue] = useState<number | null>(null);
  const latestHueRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
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
        type="button"
        className={styles.avatarButton}
        onClick={() => setOpen(v => !v)}
        title="Change color"
      >
        <WorkerAvatar sessionId={sessionId} color={color} size={size} isRaw={isRaw} />
      </button>
      {open && (
        <div className={styles.popover} role="dialog" aria-label="Choose color">
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
        </div>
      )}
    </div>
  );
}
