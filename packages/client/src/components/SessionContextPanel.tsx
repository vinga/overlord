import React, { useEffect, useState } from 'react';
import type { Room, Session } from '../types';
import { JiraChips } from './JiraChips';
import { PrChips } from './PrChips';
import { PinBar, PinAdder, jiraKeyOf, pinRef } from './PinBar';
import { WorkerArtifactPill } from './WorkerArtifactPill';
import { renderMarkdown } from '../lib/renderMarkdown';
import styles from './SessionContextPanel.module.css';

interface Props {
  session: Session | null;
  room: Room | null;
  name?: string;
  jiraBaseUrl?: string;
}

export function SessionContextPanel({ session, room, name, jiraBaseUrl }: Props) {
  const plan = session?.latestPlan;
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
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
        <JiraChips keys={tickets} baseUrl={jiraBaseUrl} sessionId={session.sessionId} />
        {pinsOfKind('ticket')}
        {!tickets.length && !allPins.some(p => p.kind === 'ticket') && <p className={styles.muted}>No ticket attached</p>}
      </section>
      <section className={styles.card} aria-label="Pull requests">
        <h3>PR</h3>
        <PrChips refs={prs} card sessionId={session.sessionId} />
        {pinsOfKind('pr')}
        {showRoomPr && <a className={styles.prLink} href={roomPr.url} target="_blank" rel="noopener noreferrer">
          <span>#{roomPr.number} · {roomPr.isDraft ? 'DRAFT' : roomPr.state}</span>
          <strong>{roomPr.title}</strong>
        </a>}
        {!prs.length && !showRoomPr && !allPins.some(p => p.kind === 'pr') && <p className={styles.muted}>No PR attached</p>}
      </section>
      <section className={styles.card} aria-label="Plan">
        <h3>Plan</h3>
        {plan ? <>
          <WorkerArtifactPill artifactId={plan.artifactId} title={plan.title}
            planStatus={plan.status as 'draft' | 'active' | 'done' | 'archived'} timestamp={plan.updatedAt} />
          {error ? <p className={styles.muted}>Could not load plan. <button onClick={() => setRetry(n => n + 1)}>Retry</button></p>
            : body === null ? <p className={styles.muted}>Loading plan…</p>
            : <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />}
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
