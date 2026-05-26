import React from 'react';

type Kind = 'bug' | 'story' | 'epic' | 'task' | 'subtask' | 'unknown';

/** JIRA's color language for the standard issue types. */
const COLORS: Record<Kind, string> = {
  bug: '#E5493A',
  story: '#63BA3C',
  epic: '#904EE2',
  task: '#4BADE8',
  subtask: '#4BADE8',
  unknown: '#8C9BAB',
};

function classify(type?: string): Kind {
  const t = (type ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('sub')) return 'subtask';   // "Sub-task" before "task"
  if (t.includes('bug') || t.includes('defect')) return 'bug';
  if (t.includes('epic')) return 'epic';
  if (t.includes('story')) return 'story';
  if (t.includes('task')) return 'task';
  return 'unknown';
}

/** White glyph centered on the rounded-square badge, per type. */
function glyph(kind: Kind): React.ReactNode {
  switch (kind) {
    case 'bug':
      // filled circle (JIRA bug = round red marker)
      return <circle cx="8" cy="8" r="3.2" fill="#fff" />;
    case 'story':
      // bookmark
      return <path d="M5.5 4.5h5v7l-2.5-2-2.5 2z" fill="#fff" />;
    case 'epic':
      // lightning bolt
      return <path d="M8.8 3.5L5 8.6h2.4L7 12.5 11 7.2H8.4z" fill="#fff" />;
    case 'subtask':
      // two stacked bars
      return <path d="M4.8 6h6.4v1.6H4.8zM4.8 8.6h4.2v1.6H4.8z" fill="#fff" />;
    case 'task':
      // checkmark
      return <path d="M5.2 8.2l1.9 1.9 3.6-3.8" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    default:
      return <circle cx="8" cy="8" r="2.4" fill="#fff" />;
  }
}

export function JiraTypeIcon({ type }: { type?: string }) {
  const kind = classify(type);
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={COLORS[kind]} />
      {glyph(kind)}
    </svg>
  );
}
