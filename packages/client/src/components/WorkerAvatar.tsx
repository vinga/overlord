import React from 'react';
import type { WorkerIcon } from '../types';
import { WorkerGlyph } from './workerGlyphs';

interface WorkerAvatarProps {
  sessionId: string;
  color: string;
  size?: number;
  isRaw?: boolean;
  icon?: WorkerIcon;
}

function lightenHsl(color: string, amount: number): string {
  const match = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!match) return color;
  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]);
  const l = Math.min(100, parseFloat(match[3]) + amount);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export function WorkerAvatar({ sessionId, color, size = 36, isRaw = false, icon }: WorkerAvatarProps) {
  const highlightColor = lightenHsl(color, 25);
  const gradId = `grad-avatar-${sessionId}`;
  const height = size;
  const width = Math.round(size * (40 / 52));
  // An explicitly picked glyph overrides the raw terminal variant.
  const glyph: WorkerIcon = icon ?? 'user';

  if (isRaw && glyph === 'user') {
    const rawWidth = Math.round(size * (46 / 34));
    const rawHeight = size;
    return (
      <svg
        width={rawWidth}
        height={rawHeight}
        viewBox="0 0 46 34"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="60%" y2="100%">
            <stop offset="0%" stopColor={highlightColor} />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        <rect x="1.5" y="1.5" width="43" height="31" rx="3.5" fill={`url(#${gradId})`} />
        <rect x="1.5" y="1.5" width="43" height="7" rx="3.5" fill="rgba(0,0,0,0.28)" />
        <circle cx="6" cy="5" r="1.4" fill="rgba(255,255,255,0.55)" />
        <circle cx="10.5" cy="5" r="1.4" fill="rgba(255,255,255,0.35)" />
        <circle cx="15" cy="5" r="1.4" fill="rgba(255,255,255,0.2)" />
        <path d="M 8 15 L 14 20 L 8 25" stroke="rgba(255,255,255,0.92)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <rect x="17" y="24" width="11" height="2" rx="1" fill="rgba(255,255,255,0.92)" />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 40 52"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="60%" y2="100%">
          <stop offset="0%" stopColor={highlightColor} />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>
      <WorkerGlyph icon={glyph} gradientUrl={`url(#${gradId})`} color={color} />
    </svg>
  );
}
