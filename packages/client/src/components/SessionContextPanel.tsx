import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Room, Session } from '../types';
import { JiraChips } from './JiraChips';
import { PrChips, PrGlyph } from './PrChips';
import prStyles from './PrChips.module.css';
import { PinBar, PinAdder, jiraKeyOf, pinRef } from './PinBar';
import { renderMarkdown } from '../lib/renderMarkdown';
import styles from './SessionContextPanel.module.css';

interface Props {
  session: Session | null;
  room: Room | null;
  name?: string;
  jiraBaseUrl?: string;
}

/** First few lines of the plan as plain text — headings and markdown marks
 *  stripped, the leading title line dropped (the card shows the title). */
function planExcerpt(body: string): string {
  return body.split('\n')
    .map(l => l.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').replace(/[*_`>]/g, '').trim())
    .filter(Boolean)
    .slice(1, 6)
    .join(' · ');
}

/** The full plan in a centred dialog, 70% of the viewport. Esc / backdrop closes. */
function PlanDialog({ title, status, body, onClose }: { title: string; status: string; body: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className={styles.dialogBackdrop} onMouseDown={onClose}>
      <div className={styles.dialog} role="dialog" aria-label={`Plan: ${title}`} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.dialogHeader}>
          <span className={styles.dialogTitle}>{title}</span>
          <span className={styles.planStatus} data-status={status}>{status}</span>
          <button type="button" className={styles.dialogClose} onClick={onClose} aria-label="Close plan">✕</button>
        </div>
        <div className={`${styles.markdown} ${styles.dialogBody}`}
          dangerouslySetInnerHTML={{ __html: body === null ? 'Loading…' : renderMarkdown(body) }} />
      </div>
    </div>,
    document.body,
  );
}

export function SessionContextPanel({ session, room, name, jiraBaseUrl }: Props) {
  const plan = session?.latestPlan;
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [planOpen, setPlanOpen] = useState(false);
  useEffect(() => {
    setBody(null);
    setError(false);
    if (!plan) return;
    let cancelled = false;
    void fetch(`/api/artifacts/${encodeURIComponent(plan.artifactId)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ artifact?: { body?: string } }>;
      })
      .then(data => { if (!cancelled) setBody(data.artifact?.body ?? ''); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [plan?.artifactId, plan?.updatedAt, retry]);

  if (!session) {
    return room
      ? <aside className={styles.reserved} aria-label={`Reserved context for room ${room.name}`} />
      : <div className={styles.empty}>Select a room or session</div>;
  }

  const sessionPins = session.pins ?? [];
  const roomPins = room?.pins ?? [];
  const allPins = [...sessionPins, ...roomPins];
  const pinnedTickets = new Set(allPins.map(jiraKeyOf).filter(Boolean));
  const pinnedPrs = new Set(allPins.map(pinRef).filter(Boolean));
  const tickets = (session.jiraKeys ?? []).filter(k => !pinnedTickets.has(k));
  const prs = (session.prRefs ?? []).filter(r => !pinnedPrs.has(`pr:${r.toLowerCase()}`));
  const id = session.overlordId ?? session.sessionId;
  const pinsOfKind = (kind: 'ticket' | 'pr' | 'other') => {
    const matches = (p: typeof sessionPins[number]) => kind === 'other'
      ? p.kind !== 'ticket' && p.kind !== 'pr' : p.kind === kind;
    return <>
      <PinBar pins={sessionPins.filter(matches)} overlordId={id} multiline adoptSessionId={session.sessionId} />
      {room && <PinBar pins={roomPins.filter(matches)} cwd={room.cwd} multiline adoptSessionId={session.sessionId} />}
    </>;
  };
  const roomPr = room?.pullRequest;
  const showRoomPr = roomPr && !allPins.some(p => p.url === roomPr.url)
    && !(session.prRefs ?? []).some(ref => {
      const m = roomPr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
      return m && ref.toLowerCase() === `${m[1]}#${m[2]}`.toLowerCase();
    });

  return (
    <aside className={styles.panel} aria-label="Session context">
      <section className={styles.card} aria-label="Ticket">
        <h3>Ticket</h3>
        <JiraChips keys={tickets} baseUrl={jiraBaseUrl} sessionId={session.sessionId} card />
        {pinsOfKind('ticket')}
        {!tickets.length && !allPins.some(p => p.kind === 'ticket') && <p className={styles.muted}>No ticket attached</p>}
      </section>
      <section className={styles.card} aria-label="Pull requests">
        <h3>PR</h3>
        <PrChips refs={prs} card sessionId={session.sessionId} />
        {pinsOfKind('pr')}
        {/* The room's branch PR, drawn as the same card as PrChips. */}
        {showRoomPr && (() => {
          const repo = roomPr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//i)?.[1];
          const state = roomPr.isDraft && roomPr.state === 'OPEN' ? 'DRAFT' : roomPr.state;
          return (
            <div className={`${prStyles.row} ${prStyles.card}`}>
              <span className={prStyles.chipWrap}>
                <a className={prStyles.chip} href={roomPr.url} target="_blank" rel="noopener noreferrer" title={`${repo ?? ''}#${roomPr.number} — ${roomPr.title}`}>
                  <PrGlyph />
                  <span className={prStyles.chipRef}>#{roomPr.number}</span>
                  {repo && <span className={prStyles.chipRepo}>{repo}</span>}
                  <span className={prStyles.chipTitle}>{roomPr.title}</span>
                  <span className={prStyles.state} data-state={state}>{state}</span>
                </a>
              </span>
            </div>
          );
        })()}
        {!prs.length && !showRoomPr && !allPins.some(p => p.kind === 'pr') && <p className={styles.muted}>No PR attached</p>}
      </section>
      <section className={styles.card} aria-label="Plan">
        <h3>Plan</h3>
        {plan ? <>
          {/* A small card like the ticket ones; the full plan opens in a dialog. */}
          <button type="button" className={styles.planCard} onClick={() => setPlanOpen(true)} title="Open plan">
            <span className={styles.planCardTop}>
              <span className={styles.planTitle}>{plan.title}</span>
              <span className={styles.planStatus} data-status={plan.status}>{plan.status}</span>
            </span>
            {error ? <span className={styles.planExcerpt}>Could not load plan</span>
              : body === null ? <span className={styles.planExcerpt}>Loading…</span>
              : <span className={styles.planExcerpt}>{planExcerpt(body)}</span>}
          </button>
          {error && <button className={styles.retry} onClick={() => setRetry(n => n + 1)}>Retry</button>}
          {planOpen && <PlanDialog title={plan.title} status={plan.status} body={body} onClose={() => setPlanOpen(false)} />}
        </> : <p className={styles.muted}>No plan attached</p>}
      </section>
      <section className={styles.card} aria-label="Pins">
        <h3>Pins</h3>
        {pinsOfKind('other')}
        {!sessionPins.some(p => p.kind !== 'ticket' && p.kind !== 'pr') && <PinAdder overlordId={id} />}
      </section>
    </aside>
  );
}
