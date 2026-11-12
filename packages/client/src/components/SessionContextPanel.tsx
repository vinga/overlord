import React, { useEffect, useState } from 'react';
import type { Room, Session } from '../types';
import { JiraChips } from './JiraChips';
import { PrChips, PrGlyph } from './PrChips';
import prStyles from './PrChips.module.css';
import { PinBar, PinAdder, jiraKeyOf, pinRef } from './PinBar';
import { renderMarkdown } from '../lib/renderMarkdown';
import styles from './SessionContextPanel.module.css';
import { ReadingDialog } from './ReadingDialog';
import { SessionContextNotes } from './SessionContextNotes';

type ContextView = 'context' | 'notes';
const VIEW_KEY = 'overlord.sessionContextView';

function loadView(): ContextView {
  try { return localStorage.getItem(VIEW_KEY) === 'notes' ? 'notes' : 'context'; } catch { return 'context'; }
}

interface Props {
  session: Session | null;
  room: Room | null;
  name?: string;
  jiraBaseUrl?: string;
}

/** The full plan in the shared reading dialog. */
function PlanDialog({ title, status, body, onClose }: { title: string; status: string; body: string | null; onClose: () => void }) {
  return (
    <ReadingDialog title={title} onClose={onClose} badge={<span className={styles.planStatus} data-status={status}>{status}</span>}>
      <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: body === null ? 'Loading…' : renderMarkdown(body) }} />
    </ReadingDialog>
  );
}

export function SessionContextPanel({ session, room, name, jiraBaseUrl }: Props) {
  const plan = session?.latestPlan;
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [planOpen, setPlanOpen] = useState(false);
  const [view, setView] = useState<ContextView>(loadView);
  const switchView = (next: ContextView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* per-viewer convenience only */ }
  };
  // Optimistic ticket order until the snapshot catches up; dropped once it does.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const serverOrder = session?.jiraKeys?.join('|');
  useEffect(() => { setLocalOrder(null); }, [serverOrder]);
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
  const pinnedPrs = new Set(allPins.map(pinRef).filter(Boolean));
  // One ordered ticket list (the server applies the user's ↑/↓ order to
  // jiraKeys): session ticket pins and mentioned tickets mixed, in that order.
  const orderedKeys = localOrder ?? session.jiraKeys ?? [];
  const sessionTicketPin = (k: string) => sessionPins.find(p => jiraKeyOf(p) === k);
  const listedKeys = new Set(orderedKeys);
  const loneSessionTicketPins = sessionPins.filter(p => p.kind === 'ticket' && !listedKeys.has(jiraKeyOf(p) ?? ''));
  const moveTicket = (from: number, to: number) => {
    if (to < 0 || to >= orderedKeys.length) return;
    const next = [...orderedKeys];
    const [k] = next.splice(from, 1);
    next.splice(to, 0, k);
    setLocalOrder(next);
    void fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/ticket-order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: next }),
    }).catch(() => setLocalOrder(null));
  };
  const prs = (session.prRefs ?? []).filter(r => !pinnedPrs.has(`pr:${r.toLowerCase()}`));
  const id = session.overlordId ?? session.sessionId;
  const pinsOfKind = (kind: 'ticket' | 'pr' | 'other') => {
    const matches = (p: typeof sessionPins[number]) => kind === 'other'
      ? p.kind !== 'ticket' && p.kind !== 'pr' : p.kind === kind;
    return <>
      <PinBar pins={sessionPins.filter(matches)} overlordId={id} multiline adoptSessionId={session.sessionId} hideAdder />
      {room && <PinBar pins={roomPins.filter(matches)} cwd={room.cwd} multiline adoptSessionId={session.sessionId} hideAdder />}
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
      <div className={styles.viewSwitch} role="tablist" aria-label="Context view">
        <button type="button" role="tab" aria-selected={view === 'context'} className={view === 'context' ? styles.viewActive : ''} onClick={() => switchView('context')}>Tickets &amp; PRs</button>
        <button type="button" role="tab" aria-selected={view === 'notes'} className={view === 'notes' ? styles.viewActive : ''} onClick={() => switchView('notes')}>Notes</button>
      </div>
      {view === 'notes' ? <SessionContextNotes sessionId={session.sessionId} /> : <>
      <section className={styles.card} aria-label="Ticket">
        <h3 className={styles.sectionHead}>Ticket<span className={styles.headAdder}><PinAdder overlordId={id} /></span></h3>
        {orderedKeys.map((k, i) => {
          const pin = sessionTicketPin(k);
          return (
            <div key={k} className={styles.ticketRow}>
              {pin
                ? <PinBar pins={[pin]} overlordId={id} multiline adoptSessionId={session.sessionId} hideAdder />
                : <JiraChips keys={[k]} baseUrl={jiraBaseUrl} sessionId={session.sessionId} card />}
              {orderedKeys.length > 1 && (
                <span className={styles.ticketMove}>
                  <button type="button" aria-label={`Move ${k} up`} title="Move up" disabled={i === 0} onClick={() => moveTicket(i, i - 1)}>↑</button>
                  <button type="button" aria-label={`Move ${k} down`} title="Move down" disabled={i === orderedKeys.length - 1} onClick={() => moveTicket(i, i + 1)}>↓</button>
                </span>
              )}
            </div>
          );
        })}
        {loneSessionTicketPins.length > 0 && <PinBar pins={loneSessionTicketPins} overlordId={id} multiline adoptSessionId={session.sessionId} hideAdder />}
        {room && <PinBar pins={roomPins.filter(p => p.kind === 'ticket' && !listedKeys.has(jiraKeyOf(p) ?? ''))} cwd={room.cwd} multiline adoptSessionId={session.sessionId} hideAdder />}
        {!orderedKeys.length && !allPins.some(p => p.kind === 'ticket') && <p className={styles.muted}>No ticket attached</p>}
      </section>
      <section className={styles.card} aria-label="Pull requests">
        <h3 className={styles.sectionHead}>PR<span className={styles.headAdder}><PinAdder overlordId={id} /></span></h3>
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
          <div className={styles.planWrap}>
          <button type="button" className={styles.planCard} onClick={() => setPlanOpen(true)} title="Open plan">
            <span className={styles.planCardTop}>
              <svg className={styles.planIcon} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="1.75" width="10" height="12.5" rx="1.5" />
                <line x1="5.75" y1="5.5" x2="10.25" y2="5.5" />
                <line x1="5.75" y1="8" x2="10.25" y2="8" />
                <line x1="5.75" y1="10.5" x2="8.5" y2="10.5" />
              </svg>
              <span className={styles.planTitle}>{plan.title}</span>
              <span className={styles.planStatus} data-status={plan.status}>{plan.status}</span>
            </span>
          </button>
          {/* × archives the plan (status 'archived'): it leaves the column but
              stays in the room's Plans tab, so nothing is lost. */}
          <button
            type="button"
            className={styles.planRemove}
            aria-label={`Archive plan ${plan.title}`}
            title="Archive plan — hides it here; still in the room's Plans tab"
            onClick={() => {
              void fetch(`/api/artifacts/${encodeURIComponent(plan.artifactId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'archived' }),
              });
            }}
          >×</button>
          </div>
          {error && <button className={styles.retry} onClick={() => setRetry(n => n + 1)}>Retry</button>}
          {planOpen && <PlanDialog title={plan.title} status={plan.status} body={body} onClose={() => setPlanOpen(false)} />}
        </> : <p className={styles.muted}>No plan attached</p>}
      </section>
      <section className={styles.card} aria-label="Pins">
        <h3 className={styles.sectionHead}>Pins<span className={styles.headAdder}><PinAdder overlordId={id} /></span></h3>
        {pinsOfKind('other')}
      </section>
      </>}
    </aside>
  );
}
