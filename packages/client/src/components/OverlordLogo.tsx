import React from 'react';

interface OverlordLogoProps {
  size?: 'sm' | 'md' | 'lg';
}

export function OverlordLogo({ size = 'md' }: OverlordLogoProps) {
  const scale = size === 'sm' ? 0.75 : size === 'lg' ? 1.4 : 1;
  const iconSize = 36 * scale;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: `${10 * scale}px`, userSelect: 'none' }}>
      {/* Crown icon */}
      <svg
        width={iconSize}
        height={iconSize * 0.72}
        viewBox="0 0 50 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <filter id="crown-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="crown-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f0cc60" />
            <stop offset="50%" stopColor="#d4af37" />
            <stop offset="100%" stopColor="#a8892b" />
          </linearGradient>
        </defs>

        {/* Crown body */}
        <path
          d="M 4 32 L 4 17 L 14 23 L 25 4 L 36 23 L 46 17 L 46 32 Z"
          fill="url(#crown-grad)"
          filter="url(#crown-glow)"
          strokeLinejoin="round"
        />

        {/* Crown base highlight */}
        <rect x="4" y="28" width="42" height="4" rx="1" fill="#f0cc60" opacity="0.35" />

        {/* Three jewel dots at peaks */}
        <circle cx="25" cy="4" r="2.2" fill="#fff" opacity="0.9" />
        <circle cx="4" cy="17" r="1.8" fill="#fff" opacity="0.7" />
        <circle cx="46" cy="17" r="1.8" fill="#fff" opacity="0.7" />

        {/* Eye slit in center of crown */}
        <ellipse cx="25" cy="21" rx="5.5" ry="2.8" fill="#07070d" opacity="0.55" />
        <ellipse cx="25" cy="21" rx="2.2" ry="2.2" fill="#1a1430" />
        <circle cx="25" cy="21" r="1.1" fill="#d4af37" opacity="0.9" />
      </svg>

      {/* Wordmark */}
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span
          style={{
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 700,
            fontSize: `${15 * scale}px`,
            letterSpacing: `${3.5 * scale}px`,
            color: '#d4af37',
            textTransform: 'uppercase' as const,
            filter: 'drop-shadow(0 0 6px rgba(212,175,55,0.35))',
          }}
        >
          Overlord
        </span>
        <span
          style={{
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 400,
            fontSize: `${9.5 * scale}px`,
            letterSpacing: `${2 * scale}px`,
            color: 'rgba(212,175,55,0.45)',
            textTransform: 'uppercase' as const,
            marginTop: `${2 * scale}px`,
          }}
        >
          Session Monitor
        </span>
      </div>
    </div>
  );
}
