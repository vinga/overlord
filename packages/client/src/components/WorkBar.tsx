import React, { useMemo, useState } from 'react';
import styles from './WorkBar.module.css';
import { usePrMeta } from '../hooks/usePrMeta';
import { buildWorkRows, type WorkRow } from '../lib/workRows';
import { useJiraMeta } from '../hooks/useJiraMeta';
import type { Pin } from '../types';
import { PinAdder, PinChip, deletePin, jiraKeyOf, pinRef, hiddenPinRefs } from './PinBar';

interface Props {
  /** The session's tickets; the first is shown by ActiveTicket, the rest here. */
  jiraKeys?: string[];
  jiraBaseUrl?: string;
  prRefs?: string[];
  prRefsAuthored?: string[];
  branches?: string[];
  /** Hand-added links. Ticket / PR pins already feed jiraKeys / prRefs on the
   *  server, so they render as those; the rest render as link chips. */
  pins?: Pin[];
  /** The room's PR — shown in the header badge, so a pin of it is left out. */
  roomPrUrl?: string;
  sessionId: string;
  overlordId?: string;
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
export function WorkBar({ jiraKeys, jiraBaseUrl, prRefs, prRefsAuthored, branches, pins, roomPrUrl, sessionId, overlordId }: Props) {
  const meta = usePrMeta();
  const jiraMeta = useJiraMeta();
  const [showMentioned, setShowMentioned] = useState(false);
  const [dismissing, setDismissing] = useState<Set<string>>(() => new Set());
  // A pinned PR is the session's own work, never just "mentioned".
  const ownRefs = useMemo(() => {
    const pinnedPrs = (pins ?? []).flatMap(p => {
      const m = p.kind === 'pr' ? p.url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i) : null;
      return m ? [`${m[1]}#${m[2]}`] : [];
    });
    return pinnedPrs.length ? [...(prRefsAuthored ?? []), ...pinnedPrs] : prRefsAuthored;
  }, [pins, prRefsAuthored]);
  const { own, mentioned } = useMemo(
    () => buildWorkRows(prRefs, ownRefs, branches, meta),
    [prRefs, ownRefs, branches, meta],
  );
  const otherTickets = useMemo(() => {
    const titles = new Map<string, string>();
    for (const p of pins ?? []) { const k = jiraKeyOf(p); if (k) titles.set(k, p.title); }
    return (jiraKeys ?? []).slice(1).map(k => ({ key: k, title: titles.get(k) }));
  }, [jiraKeys, pins]);
  // Pins not already on screen as a ticket, a PR row or the room's PR badge.
  const linkPins = useMemo(() => {
    const shown = new Set(hiddenPinRefs(jiraKeys, prRefs, roomPrUrl).split('\n'));
    for (const r of ownRefs ?? []) shown.add(`pr:${r.toLowerCase()}`);
    return (pins ?? []).filter(p => { const r = pinRef(p); return r === undefined || !shown.has(r); });
  }, [pins, jiraKeys, prRefs, ownRefs, roomPrUrl]);

  const visibleOwn = own.filter(r => !r.ref || !dismissing.has(r.ref));
  const visibleMentioned = mentioned.filter(r => !r.ref || !dismissing.has(r.ref));
  const visibleTickets = otherTickets.filter(t => !dismissing.has(t.key));
  const base = jiraBaseUrl?.replace(/\/+$/, '');
  if (!overlordId && visibleTickets.length === 0 && visibleOwn.length === 0
    && visibleMentioned.length === 0 && linkPins.length === 0) return null;

  const dismissTicket = (key: string) => {
    const undo = () => setDismissing(prev => { const next = new Set(prev); next.delete(key); return next; });
    setDismissing(prev => new Set(prev).add(key));
    void fetch(`/api/sessions/${sessionId}/jira-keys/${encodeURIComponent(key)}`, { method: 'DELETE' })
      .then(r => { if (!r.ok) undo(); }).catch(undo);
  };

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
      {visibleTickets.map(t => (
        <PinChip
          key={`jira:${t.key}`}
          href={base ? `${base}/browse/${encodeURIComponent(t.key)}` : '#'}
          jiraKey={t.key}
          jiraMeta={jiraMeta[t.key]}
          label={t.title}
          onRemove={() => dismissTicket(t.key)}
          removeLabel={`Dismiss ${t.key}`}
        />
      ))}
      {visibleOwn.map(r => chip(r, false))}
      {linkPins.map(p => (
        <PinChip
          key={p.id}
          href={p.url}
          jiraKey={jiraKeyOf(p)}
          jiraMeta={(() => { const k = jiraKeyOf(p); return k ? jiraMeta[k] : undefined; })()}
          kind={p.kind}
          label={p.title}
          onRemove={() => deletePin(p.id, { overlordId })}
          removeLabel={`Unpin ${p.title || p.url}`}
        />
      ))}
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
      {overlordId && <PinAdder overlordId={overlordId} />}
    </div>
  );
}
