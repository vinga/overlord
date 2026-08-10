import React from 'react';
import type { WorkerIcon } from '../types';

interface GlyphProps {
  /** CSS url() reference to the caller's <linearGradient>, e.g. `url(#grad-abc)` */
  gradientUrl: string;
  /** Flat fill for secondary shapes (arms/legs, handle, stand) — the base color. */
  color: string;
}

/**
 * Shared avatar glyph shapes for the 40×52 worker viewBox. Rendered inside the
 * caller's <svg> (Worker office grid, WorkerAvatar panel header, ColorPicker
 * presets) so each keeps its own size, class, and gradient def.
 */
export function WorkerGlyph({ icon, gradientUrl, color }: GlyphProps & { icon: WorkerIcon }) {
  switch (icon) {
    case 'dashboard':
      return (
        <>
          {/* Monitor card */}
          <rect x="2" y="6" width="36" height="34" rx="4" fill={gradientUrl} />
          {/* 2×2 tiles */}
          <rect x="6" y="10" width="13" height="12" rx="2" fill="rgba(0,0,0,0.28)" />
          <rect x="21" y="10" width="13" height="12" rx="2" fill="rgba(0,0,0,0.28)" />
          <rect x="6" y="24" width="13" height="12" rx="2" fill="rgba(0,0,0,0.28)" />
          <rect x="21" y="24" width="13" height="12" rx="2" fill="rgba(0,0,0,0.28)" />
          {/* Bar chart in top-left tile */}
          <rect x="8" y="17" width="2.5" height="3" rx="1" fill="rgba(255,255,255,0.92)" />
          <rect x="11.5" y="14.5" width="2.5" height="5.5" rx="1" fill="rgba(255,255,255,0.92)" />
          <rect x="15" y="12.5" width="2.5" height="7.5" rx="1" fill="rgba(255,255,255,0.92)" />
          {/* Spark line in top-right tile */}
          <path d="M 23 19 L 26 15.5 L 29 17.5 L 32 13.5" stroke="rgba(255,255,255,0.92)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Donut gauge in bottom-left tile */}
          <circle cx="12.5" cy="30" r="3.6" stroke="rgba(255,255,255,0.35)" strokeWidth="2" fill="none" />
          <path d="M 12.5 26.4 A 3.6 3.6 0 0 1 16.1 30" stroke="rgba(255,255,255,0.92)" strokeWidth="2" strokeLinecap="round" fill="none" />
          {/* Text rows in bottom-right tile */}
          <rect x="23.5" y="27" width="8.5" height="2" rx="1" fill="rgba(255,255,255,0.92)" />
          <rect x="23.5" y="31" width="5.5" height="2" rx="1" fill="rgba(255,255,255,0.5)" />
          {/* Stand */}
          <rect x="17" y="40" width="6" height="6" rx="1.5" fill={color} />
          <rect x="11" y="46" width="18" height="3.5" rx="1.75" fill={color} />
        </>
      );
    case 'ticket':
      return (
        <>
          {/* Wand shaft */}
          <line x1="8" y1="46" x2="27" y2="22" stroke={color} strokeWidth="7" strokeLinecap="round" />
          {/* Grip band */}
          <line x1="12.5" y1="40.5" x2="16.5" y2="35.5" stroke="rgba(255,255,255,0.8)" strokeWidth="7" />
          {/* Star at the tip */}
          <path d="M 29 4 L 32.2 12.8 L 40 16 L 32.2 19.2 L 29 28 L 25.8 19.2 L 18 16 L 25.8 12.8 Z" fill={gradientUrl} />
          {/* Sparkles */}
          <path d="M 11 8 L 12.2 11.3 L 15.5 12.5 L 12.2 13.7 L 11 17 L 9.8 13.7 L 6.5 12.5 L 9.8 11.3 Z" fill={gradientUrl} />
          <circle cx="6.5" cy="25" r="2.2" fill={gradientUrl} />
        </>
      );
    case 'story':
      return (
        <>
          {/* Badge — JIRA story is a bookmark on a rounded square */}
          <rect x="3" y="7" width="34" height="34" rx="8" fill={gradientUrl} />
          <rect x="3" y="7" width="34" height="34" rx="8" stroke={color} strokeWidth="2" fill="none" />
          {/* Bookmark */}
          <path d="M 13.5 15 L 26.5 15 L 26.5 34 L 20 28.5 L 13.5 34 Z" fill="rgba(255,255,255,0.94)" />
          {/* Stand */}
          <rect x="17" y="41" width="6" height="5" rx="1.5" fill={color} />
          <rect x="11" y="46" width="18" height="3.5" rx="1.75" fill={color} />
        </>
      );
    case 'task':
      return (
        <>
          {/* Badge — JIRA task is a check on a rounded square */}
          <rect x="3" y="7" width="34" height="34" rx="8" fill={gradientUrl} />
          <rect x="3" y="7" width="34" height="34" rx="8" stroke={color} strokeWidth="2" fill="none" />
          {/* Check */}
          <path d="M 12 24.5 L 18 30.5 L 28.5 18.5" stroke="rgba(255,255,255,0.94)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Stand */}
          <rect x="17" y="41" width="6" height="5" rx="1.5" fill={color} />
          <rect x="11" y="46" width="18" height="3.5" rx="1.75" fill={color} />
        </>
      );
    case 'investigate':
      return (
        <>
          {/* Glass */}
          <circle cx="17" cy="19" r="12" fill={gradientUrl} fillOpacity="0.35" />
          {/* Rim */}
          <circle cx="17" cy="19" r="12" stroke={gradientUrl} strokeWidth="5" fill="none" />
          {/* Glint */}
          <path d="M 10.5 14 A 9 9 0 0 1 15.5 10.8" stroke="rgba(255,255,255,0.8)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          {/* Handle */}
          <line x1="26.5" y1="28.5" x2="36" y2="38" stroke={color} strokeWidth="7" strokeLinecap="round" />
        </>
      );
    case 'teach':
      return (
        <>
          {/* Ear tufts */}
          <path d="M 9 14 L 11 4 L 18 9.5 Z" fill={gradientUrl} />
          <path d="M 31 14 L 29 4 L 22 9.5 Z" fill={gradientUrl} />
          {/* Body */}
          <rect x="8" y="8" width="24" height="34" rx="12" fill={gradientUrl} />
          {/* Eyes */}
          <circle cx="15" cy="19" r="5.5" fill="rgba(255,255,255,0.9)" />
          <circle cx="25" cy="19" r="5.5" fill="rgba(255,255,255,0.9)" />
          <circle cx="15.6" cy="19.6" r="2.4" fill="rgba(0,0,0,0.72)" />
          <circle cx="24.4" cy="19.6" r="2.4" fill="rgba(0,0,0,0.72)" />
          {/* Beak */}
          <path d="M 17.8 25 L 22.2 25 L 20 29 Z" fill="rgba(0,0,0,0.4)" />
          {/* Belly feathers */}
          <path d="M 13.5 33 L 16.5 35.5 L 19.5 33 M 20.5 33 L 23.5 35.5 L 26.5 33 M 17 37.5 L 20 40 L 23 37.5" stroke="rgba(0,0,0,0.25)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Feet */}
          <rect x="12.5" y="42" width="5.5" height="4.5" rx="2.2" fill={color} />
          <rect x="22" y="42" width="5.5" height="4.5" rx="2.2" fill={color} />
        </>
      );
    case 'notes':
      return (
        <g transform="rotate(35 20 24)">
          {/* Head disc */}
          <rect x="11" y="4" width="18" height="6.5" rx="3.2" fill={gradientUrl} />
          <rect x="14" y="5.5" width="7" height="1.8" rx="0.9" fill="rgba(255,255,255,0.55)" />
          {/* Waist */}
          <path d="M 16 10.5 L 24 10.5 L 22 19 L 18 19 Z" fill={gradientUrl} />
          {/* Collar */}
          <rect x="14" y="19" width="12" height="5" rx="2.4" fill={color} />
          {/* Needle */}
          <path d="M 20 24 L 20 42" stroke="rgba(255,255,255,0.75)" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      );
    case 'btw':
      return (
        <>
          {/* Speech bubble */}
          <rect x="2" y="5" width="36" height="29" rx="9" fill={gradientUrl} />
          {/* Tail */}
          <path d="M 11 32 L 8 45 L 22 34 Z" fill={gradientUrl} />
          {/* Aside dots */}
          <circle cx="12" cy="19.5" r="3" fill="rgba(255,255,255,0.92)" />
          <circle cx="20" cy="19.5" r="3" fill="rgba(255,255,255,0.65)" />
          <circle cx="28" cy="19.5" r="3" fill="rgba(255,255,255,0.4)" />
        </>
      );
    case 'release':
      return (
        <>
          {/* Rocket body */}
          <path d="M 20 2 C 26.5 7.5 29 15 29 25 L 29 31 L 11 31 L 11 25 C 11 15 13.5 7.5 20 2 Z" fill={gradientUrl} />
          {/* Fins */}
          <path d="M 11 23 L 3.5 33.5 L 11 33.5 Z" fill={color} />
          <path d="M 29 23 L 36.5 33.5 L 29 33.5 Z" fill={color} />
          {/* Window */}
          <circle cx="20" cy="15" r="4.4" fill="rgba(255,255,255,0.9)" />
          <circle cx="20" cy="15" r="2.5" fill="rgba(0,0,0,0.5)" />
          {/* Nozzle */}
          <rect x="15.5" y="31" width="9" height="3.5" rx="1" fill="rgba(0,0,0,0.35)" />
          {/* Flame */}
          <path d="M 20 36 C 24 39.5 24.5 44 20 50 C 15.5 44 16 39.5 20 36 Z" fill={color} />
          <path d="M 20 39 C 22 41.5 22 44 20 47.5 C 18 44 18 41.5 20 39 Z" fill="rgba(255,255,255,0.75)" />
        </>
      );
    case 'bug':
      return (
        <>
          {/* Legs */}
          <g stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none">
            <path d="M 11 22 L 3 17" />
            <path d="M 11 29 L 2.5 29" />
            <path d="M 11 36 L 3.5 41" />
            <path d="M 29 22 L 37 17" />
            <path d="M 29 29 L 37.5 29" />
            <path d="M 29 36 L 36.5 41" />
          </g>
          {/* Antennae */}
          <g stroke={color} strokeWidth="2.4" strokeLinecap="round" fill="none">
            <path d="M 16 12 L 12 5" />
            <path d="M 24 12 L 28 5" />
          </g>
          {/* Head */}
          <circle cx="20" cy="14" r="6.5" fill={gradientUrl} />
          <circle cx="17.4" cy="13" r="1.6" fill="rgba(0,0,0,0.5)" />
          <circle cx="22.6" cy="13" r="1.6" fill="rgba(0,0,0,0.5)" />
          {/* Shell */}
          <ellipse cx="20" cy="31" rx="11" ry="14" fill={gradientUrl} />
          {/* Wing split */}
          <line x1="20" y1="18" x2="20" y2="45" stroke="rgba(0,0,0,0.38)" strokeWidth="1.8" />
          {/* Spots */}
          <circle cx="14.8" cy="26" r="2.4" fill="rgba(0,0,0,0.32)" />
          <circle cx="25.2" cy="30" r="2.4" fill="rgba(0,0,0,0.32)" />
          <circle cx="15.6" cy="35.5" r="2" fill="rgba(0,0,0,0.32)" />
        </>
      );
    case 'docs':
      return (
        <>
          {/* Covers */}
          <path d="M 3 8 L 18.5 11 L 18.5 44 L 3 41 Z" fill={gradientUrl} />
          <path d="M 37 8 L 21.5 11 L 21.5 44 L 37 41 Z" fill={gradientUrl} />
          {/* Spine */}
          <rect x="18" y="10" width="4" height="34" rx="1.4" fill={color} />
          {/* Text rows */}
          <g fill="rgba(255,255,255,0.75)">
            <rect x="6" y="16" width="10" height="2.2" rx="1.1" />
            <rect x="6" y="21.5" width="10" height="2.2" rx="1.1" />
            <rect x="6" y="27" width="7" height="2.2" rx="1.1" />
            <rect x="24" y="16" width="10" height="2.2" rx="1.1" />
            <rect x="24" y="21.5" width="10" height="2.2" rx="1.1" />
            <rect x="24" y="27" width="7" height="2.2" rx="1.1" />
          </g>
          {/* Bookmark */}
          <path d="M 28 8.5 L 33 7.5 L 33 18 L 30.5 15.5 L 28 19 Z" fill={color} />
        </>
      );
    case 'config':
      return (
        <>
          {/* Cog teeth — 8 spokes around the hub */}
          <g fill={gradientUrl}>
            <rect x="16.5" y="3" width="7" height="42" rx="2.5" />
            <rect x="16.5" y="3" width="7" height="42" rx="2.5" transform="rotate(45 20 24)" />
            <rect x="16.5" y="3" width="7" height="42" rx="2.5" transform="rotate(90 20 24)" />
            <rect x="16.5" y="3" width="7" height="42" rx="2.5" transform="rotate(135 20 24)" />
          </g>
          {/* Body */}
          <circle cx="20" cy="24" r="14" fill={gradientUrl} />
          {/* Rim */}
          <circle cx="20" cy="24" r="14" stroke={color} strokeWidth="2" fill="none" />
          {/* Bore */}
          <circle cx="20" cy="24" r="6" fill="rgba(0,0,0,0.45)" />
          <circle cx="20" cy="24" r="6" stroke="rgba(255,255,255,0.85)" strokeWidth="2" fill="none" />
        </>
      );
    case 'done':
      return (
        <>
          {/* Disc */}
          <circle cx="20" cy="24" r="18" fill={gradientUrl} />
          {/* Inner rim */}
          <circle cx="20" cy="24" r="18" stroke={color} strokeWidth="2" fill="none" />
          {/* Checkmark */}
          <path d="M 11.5 24.5 L 17.5 30.5 L 28.5 17.5" stroke="rgba(255,255,255,0.95)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      );
    default:
      return (
        <>
          {/* Head */}
          <circle cx="20" cy="12" r="10" fill={gradientUrl} />
          {/* Eyes */}
          <circle cx="16" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
          <circle cx="24" cy="11" r="2" fill="rgba(0,0,0,0.5)" />
          {/* Body */}
          <rect x="10" y="24" width="20" height="22" rx="3" fill={gradientUrl} />
          {/* Arms */}
          <rect x="2" y="24" width="7" height="14" rx="2" fill={color} />
          <rect x="31" y="24" width="7" height="14" rx="2" fill={color} />
          {/* Legs */}
          <rect x="11" y="46" width="7" height="6" rx="2" fill={color} />
          <rect x="22" y="46" width="7" height="6" rx="2" fill={color} />
        </>
      );
  }
}
