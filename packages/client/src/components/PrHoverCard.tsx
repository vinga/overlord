import { createPortal } from 'react-dom';
import type { PrCheck, PrDetail } from '../types';
import { usePeekCard, cardPosition, type PeekShown } from '../hooks/usePeekCard';
import { usePrMeta } from '../hooks/usePrMeta';
import { loadPrDetail, type PrLoaded } from '../lib/prDetail';
import { renderMarkdown } from '../lib/renderMarkdown';
import { PrGlyph } from './PrChips';
import prStyles from './PrChips.module.css';
import styles from './JiraHoverCard.module.css';
import own from './PrHoverCard.module.css';
import { CopyUrl } from './CopyUrl';

// Hover card for `[data-pr-ref]` chips inside `container`, opened from their
// peek icon (PrPeek): what an open PR is waiting on, its checks, reviews and
// description. Data from `GET /api/pr-detail` (server cache: 60s open PRs).

const WIDTH = 760;
const MAX_HEIGHT = 900;

interface Props {
  container: HTMLElement | null;
}

export function PrHoverCard({ container }: Props) {
  const card = usePeekCard<PrLoaded>({ container, keyAttr: 'data-pr-ref', peekAttr: 'data-pr-peek', load: loadPrDetail });
  if (!card.shown) return null;
  return createPortal(
    <Card
      cardRef={card.cardRef}
      shown={card.shown}
      container={container}
      onEnter={card.onEnter}
      onLeave={card.onLeave}
      onPin={card.setPinned}
      onClose={card.close}
    />,
    document.body,
  );
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorText(error: string): string {
  if (error === 'not-found') return 'PR not found, or no access to it with gh.';
  return 'Could not load PR details.';
}

const CHECK_ORDER: PrCheck['state'][] = ['failed', 'running', 'passed', 'skipped'];
const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', COMMENTED: 'commented',
};

interface CardProps {
  cardRef: React.Ref<HTMLDivElement>;
  shown: PeekShown<PrLoaded>;
  container: HTMLElement | null;
  onEnter: () => void;
  onLeave: (e: React.MouseEvent) => void;
  onPin: (pinned: boolean) => void;
  onClose: () => void;
}

function Card({ cardRef, shown, container, onEnter, onLeave, onPin, onClose }: CardProps) {
  const metaMap = usePrMeta();
  const { key, loaded, pinned } = shown;
  const detail: PrDetail | undefined = loaded && 'detail' in loaded ? loaded.detail : undefined;
  const meta = metaMap?.[key];
  const rawState = detail?.state ?? meta?.state;
  const state = (detail?.isDraft ?? meta?.isDraft) && rawState === 'OPEN' ? 'DRAFT' : rawState;
  const title = detail?.title ?? meta?.title;
  const href = detail?.url ?? meta?.url;
  const hash = key.lastIndexOf('#');
  const repo = hash > 0 ? key.slice(0, hash) : key;
  const number = hash > 0 ? key.slice(hash) : '';
  const pos = cardPosition(shown.anchor, container, WIDTH, MAX_HEIGHT);

  const checks = detail ? [...detail.checks].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)) : [];
  const count = (s: PrCheck['state']) => checks.filter(c => c.state === s).length;
  const pendingReviewers = detail ? detail.requestedReviewers.filter(u => !detail.reviews.some(r => r.user === u)) : [];

  return (
    <div
      ref={cardRef}
      className={styles.card}
      style={pos}
      role="dialog"
      aria-label={`${key} details`}
      data-pinned={pinned || undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className={styles.header}>
        <span className={own.glyph}><PrGlyph /></span>
        <span className={styles.key}>{number}</span>
        <span className={own.repo}>{repo}</span>
        {state && <span className={prStyles.state} data-state={state}>{state}</span>}
        <span className={styles.spacer} />
        <CopyUrl url={href} className={styles.iconBtn} />
        {href && (
          <a className={styles.iconBtn} href={href} target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 2h5v5h-1.5V4.56L7.53 9.53 6.47 8.47l4.97-4.97H9V2ZM3.5 4H7v1.5H3.5v7h7V9H12v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4Z" /></svg>
          </a>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          data-active={pinned || undefined}
          onClick={() => onPin(!pinned)}
          title={pinned ? 'Unpin card' : 'Keep open'}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin card' : 'Keep open'}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9.83 1.5 14.5 6.17l-1.06 1.06-.71-.7-2.62 2.62.35 2.83-1.06 1.06-2.48-2.48L3.53 13.95l-1.06-1.06 3.39-3.39-2.48-2.48L4.44 5.96l2.83.35 2.62-2.62-.7-.71L9.83 1.5Z" /></svg>
        </button>
        {pinned && (
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close">✕</button>
        )}
      </div>
      {title && <div className={styles.title}>{title}</div>}

      <div className={styles.scroll}>
        {!loaded && (
          <div className={styles.skeleton} aria-label="Loading">
            <span style={{ width: '60%' }} /><span style={{ width: '85%' }} /><span style={{ width: '78%' }} /><span style={{ width: '40%' }} />
          </div>
        )}
        {loaded && 'error' in loaded && <p className={styles.muted}>{errorText(loaded.error)}</p>}
        {detail && (
          <>
            {detail.waitingOn.length > 0 && (
              <section className={styles.section}>
                <h4 className={styles.label}>Waiting on</h4>
                <ul className={own.blockers}>
                  {detail.waitingOn.map(b => (
                    <li key={b.kind} className={own.blocker} data-tone={b.tone}>
                      <span className={own.dot} aria-hidden="true" />{b.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {checks.length > 0 && (
              <section className={styles.section}>
                <h4 className={styles.label}>
                  Checks
                  <span className={styles.count}>
                    {' · '}{[
                      count('passed') && `${count('passed')} passed`,
                      count('failed') && `${count('failed')} failing`,
                      count('running') && `${count('running')} running`,
                      count('skipped') && `${count('skipped')} skipped`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </h4>
                <ul className={own.checks}>
                  {checks.filter(c => c.state === 'failed' || c.state === 'running').map(c => (
                    <li key={c.name} className={own.check} data-state={c.state}>
                      <span className={own.checkIcon} aria-hidden="true">{c.state === 'failed' ? '✕' : '◌'}</span>
                      {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a> : c.name}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(detail.reviews.length > 0 || pendingReviewers.length > 0) && (
              <section className={styles.section}>
                <h4 className={styles.label}>Reviews</h4>
                <ul className={own.reviews}>
                  {detail.reviews.map(r => (
                    <li key={r.user} className={own.review} data-state={r.state}>
                      <span className={own.reviewer}>{r.user}</span>
                      <span className={own.reviewState}>{REVIEW_LABEL[r.state] ?? r.state.toLowerCase()}</span>
                      {r.at && <span className={own.when}>{relTime(r.at)}</span>}
                    </li>
                  ))}
                  {pendingReviewers.map(u => (
                    <li key={u} className={own.review} data-state="REQUESTED">
                      <span className={own.reviewer}>{u}</span>
                      <span className={own.reviewState}>review requested</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className={styles.section}>
              <h4 className={styles.label}>Description</h4>
              {detail.body.trim()
                ? <div className={`${styles.desc} ${own.markdown}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body) }} />
                : <p className={styles.muted}>No description</p>}
            </section>
            <div className={own.footer}>
              {[
                detail.author,
                detail.headRef && detail.baseRef && `${detail.headRef} → ${detail.baseRef}`,
                detail.additions !== undefined && `+${detail.additions} −${detail.deletions ?? 0}`,
                detail.changedFiles !== undefined && `${detail.changedFiles} file${detail.changedFiles === 1 ? '' : 's'}`,
                detail.comments > 0 && `${detail.comments} comment${detail.comments === 1 ? '' : 's'}`,
                detail.state === 'MERGED'
                  ? `merged ${relTime(detail.mergedAt)}${detail.mergedBy ? ` by ${detail.mergedBy}` : ''}`
                  : detail.state === 'CLOSED' ? `closed ${relTime(detail.closedAt)}` : detail.updatedAt && `updated ${relTime(detail.updatedAt)}`,
              ].filter(Boolean).map((t, i) => <span key={i}>{t}</span>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
