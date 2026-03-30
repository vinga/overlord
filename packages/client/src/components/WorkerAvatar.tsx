import React from 'react';

interface WorkerAvatarProps {
  sessionId: string;
  color: string;
  size?: number;
}

function lightenHsl(color: string, amount: number): string {
  const match = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!match) return color;
  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]);
  const l = Math.min(100, parseFloat(match[3]) + amount);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

export function WorkerAvatar({ sessionId, color, size = 36 }: WorkerAvatarProps) {
  const highlightColor = lightenHsl(color, 25);
  const gradId = `grad-avatar-${sessionId}`;
  const height = size;
  const width = Math.round(size * (40 / 52));

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
      <circle cx="20" cy="12" r="10" fill={`url(#${gradId})`} />
      <circle cx="16" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
      <circle cx="24" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
      <rect x="10" y="24" width="20" height="22" rx="3" fill={`url(#${gradId})`} />
      <rect x="2" y="24" width="7" height="14" rx="2" fill={color} />
      <rect x="31" y="24" width="7" height="14" rx="2" fill={color} />
      <rect x="11" y="46" width="7" height="6" rx="2" fill={color} />
      <rect x="22" y="46" width="7" height="6" rx="2" fill={color} />
    </svg>
  );
}
