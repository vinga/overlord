import React, { useEffect, useRef, useState } from 'react';
import { WorkerAvatar } from './WorkerAvatar';
import styles from './ColorPicker.module.css';

const DEFAULT_COLOR = 'hsl(30, 75%, 55%)';

const PRESETS: string[] = [
  'hsl(0, 75%, 58%)',    // red
  'hsl(30, 75%, 55%)',   // orange (default)
  'hsl(175, 60%, 48%)',  // teal
  'hsl(195, 75%, 60%)',  // cyan-blue
  'hsl(280, 60%, 62%)',  // purple
  'hsl(340, 72%, 60%)',  // pink
];

function parseHue(color: string): number {
  const m = color.match(/hsl\(\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : 30;
}

interface Props {
  sessionId: string;
  color: string;
  size?: number;
  onChange: (color: string) => void;
}

export function ColorPicker({ sessionId, color, size = 44, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  const hue = parseHue(color);

  const handleHueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const h = parseFloat(e.target.value);
    onChange(`hsl(${h}, 75%, 55%)`);
  };

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.avatarButton}
        onClick={() => setOpen(v => !v)}
        title="Change color"
      >
        <WorkerAvatar sessionId={sessionId} color={color} size={size} />
      </button>
      {open && (
        <div className={styles.popover} role="dialog" aria-label="Choose color">
          <div className={styles.label}>Presets</div>
          <div className={styles.presets}>
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`${styles.preset} ${preset === color ? styles.selected : ''}`}
                style={{ background: preset }}
                onClick={() => onChange(preset)}
                title={preset}
              />
            ))}
          </div>
          <div className={styles.label}>Custom hue</div>
          <div className={styles.sliderRow}>
            <input
              type="range"
              min={0}
              max={360}
              value={hue}
              onChange={handleHueChange}
              className={styles.hueSlider}
            />
          </div>
          <div className={styles.resetRow}>
            <div className={styles.currentSwatch} style={{ background: color }} />
            <button
              type="button"
              className={styles.resetBtn}
              onClick={() => onChange(DEFAULT_COLOR)}
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
