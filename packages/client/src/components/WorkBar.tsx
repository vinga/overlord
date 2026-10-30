import React, { useMemo, useState } from 'react';
import styles from './WorkBar.module.css';
import { usePrMeta } from '../hooks/usePrMeta';
import { buildWorkRows, type WorkRow } from '../lib/workRows';

interface Props {
  prRefs?: string[];
  prRefsAuthored?: string[];
  branches?: string[];
  sessionId: string;
}

function BranchGlyph() {
  return (
    <svg className={styles.glyph} width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

/** OPEN | DRAFT | MERGED | CLOSED, or undefined while unresolved. */
function stateOf(row: WorkRow): string | undefined {
  const m = row.meta;
  return m?.isDraft && m.state === 'OPEN' ? 'DRAFT' : m?.state;
}

function hrefOf(row: WorkRow): string {
  if (row.meta?.url) return row.meta.url;
  if (row.number) return `https://github.com/${row.repo}/pull/${row.number}`;
  if (row.branch) return `https://github.com/${row.repo}/tree/${row.branch}`;
  return `https://github.com/${row.repo}`;
}

function tooltipOf(row: WorkRow): string {
  const parts = [row.repo];
  if (row.branch) parts.push(`branch ${row.branch}`);
  if (row.number) parts.push(`#${row.number}${row.meta?.title ? ` — ${row.meta.title}` : ''}`);
  const state = stateOf(row);
  if (state) parts.push(state.toLowerCase());
  else if (!row.number) parts.push('pushed, no PR');
  return parts.join(' · ');
}

/** The session's own PRs and pushed branches across repos, one chip each.
 *  PRs it only mentioned collapse into "+N mentioned". */
export function WorkBar({ prRefs, prRefsAuthored, branches, sessionId }: Props) {
  const meta = usePrMeta();
  const [showMentioned, setShowMentioned] = useState(false);
  const [dismissing, setDismissing] = useState<Set<string>>(() => new Set());
  const { own, mentioned } = useMemo(
    () => buildWorkRows(prRefs, prRefsAuthored, branches, meta),
    [prRefs, prRefsAuthored, branches, meta],
  );
  const visibleOwn = own.filter(r => !r.ref || !dismissing.has(r.ref));
  const visibleMentioned = mentioned.filter(r => !r.ref || !dismissing.has(r.ref));
  if (visibleOwn.length === 0 && visibleMentioned.length === 0) return null;

  const dismiss = (e: React.MouseEvent, ref: string) => {
    e.preventDefault();
    e.stopPropagation();
    const undo = () => setDismissing(prev => { const next = new Set(prev); next.delete(ref); return next; });
    setDismissing(prev => new Set(prev).add(ref));
    void fetch(`/api/sessions/${sessionId}/pr-refs`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    }).then(r => { if (!r.ok) undo(); }).catch(undo);
  };

  const chip = (row: WorkRow, mentionedChip: boolean) => {
    const state = stateOf(row);
    const repoName = row.repo.slice(row.repo.indexOf('/') + 1);
    return (
      <a
        key={row.ref ?? `${row.repo}:${row.branch}`}
        className={`${styles.chip} ${mentionedChip ? styles.chipMentioned : ''}`}
        href={hrefOf(row)}
        target="_blank"
        rel="noopener noreferrer"
        title={tooltipOf(row)}
        data-state={state ?? (row.number ? undefined : 'BRANCH')}
      >
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.repo}>{repoName}</span>
        {row.branch && (
          <span className={styles.branch}><BranchGlyph />{row.branch}</span>
        )}
        {row.number && <span className={styles.number}>#{row.number}</span>}
        {row.ref && (
          <button
            type="button"
            className={styles.dismiss}
            onClick={(e) => dismiss(e, row.ref!)}
            aria-label={`Dismiss ${row.ref}`}
          >
            ×
          </button>
        )}
      </a>
    );
  };

  return (
    <div className={styles.bar}>
      {visibleOwn.map(r => chip(r, false))}
      {showMentioned && visibleMentioned.map(r => chip(r, true))}
      {visibleMentioned.length > 0 && (
        <button
          type="button"
          className={styles.more}
          onClick={() => setShowMentioned(v => !v)}
          title="PRs this session only linked to"
        >
          {showMentioned ? 'hide mentioned' : `+${visibleMentioned.length} mentioned`}
        </button>
      )}
    </div>
  );
}
