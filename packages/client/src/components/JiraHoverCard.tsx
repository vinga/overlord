import { createPortal } from 'react-dom';
import type { JiraIssueDetail } from '../types';
import { useJiraMeta } from '../hooks/useJiraMeta';
import { JiraTypeIcon } from './JiraTypeIcon';
import { AdfView, adfIsEmpty } from './adf/AdfView';
import jiraStyles from './JiraChips.module.css';
import styles from './JiraHoverCard.module.css';
import { CopyUrl } from './CopyUrl';
import { usePeekCard, cardPosition, type PeekShown } from '../hooks/usePeekCard';

// Hover card for `[data-jira-key]` chips inside `container`: the ticket's
// description and latest comment, fetched on demand from the server (which
// caches 5 min). It opens from the chip's own peek icon (`JiraPeek`, shown on
// chip hover) — hovering it opens the card, clicking keeps it open. The rest of
// the chip keeps its click / double-click and never opens the card.

const CLIENT_TTL_MS = 60_000;
const WIDTH = 760;
const MAX_HEIGHT = 900;

type Loaded = { detail: JiraIssueDetail } | { error: string };

const cache = new Map<string, { at: number; value: Loaded }>();

async function loadDetail(key: string): Promise<Loaded> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit.value;
  let value: Loaded;
  try {
    const res = await fetch(`/api/jira/${encodeURIComponent(key)}/detail`);
    if (res.ok) value = { detail: await res.json() as JiraIssueDetail };
    else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      value = { error: body.error ?? `HTTP ${res.status}` };
    }
  } catch {
    value = { error: 'network' };
  }
  // Errors are not cached client-side; the server already rate-limits misses.
  if ('detail' in value) cache.set(key, { at: Date.now(), value });
  return value;
}

function errorText(error: string): string {
  if (error === 'no-credentials') return 'Set Jira email and API token in Settings to see ticket details.';
  if (error === 'not-found') return 'Ticket not found, or no permission to read it.';
  return 'Could not load ticket details.';
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

/** The chip's "show details" icon; visible while the chip is hovered. */
export function JiraPeek() {
  return (
    <span className={styles.peek} data-jira-peek role="button" tabIndex={-1} aria-label="Show ticket details" title="Show details">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.5a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm.75 4v4.25h-1.5V7h1.5ZM8 4.4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" />
      </svg>
    </span>
  );
}

type Shown = PeekShown<Loaded>;

interface Props {
  container: HTMLElement | null;
  baseUrl?: string;
}

export function JiraHoverCard({ container, baseUrl }: Props) {
  const card = usePeekCard<Loaded>({ container, keyAttr: 'data-jira-key', peekAttr: 'data-jira-peek', load: loadDetail });
  if (!card.shown) return null;
  return createPortal(
    <Card
      cardRef={card.cardRef}
      shown={card.shown}
      container={container}
      baseUrl={baseUrl}
      onEnter={card.onEnter}
      onLeave={card.onLeave}
      onPin={card.setPinned}
      onClose={card.close}
    />,
    document.body,
  );
}

interface CardProps {
  cardRef: React.Ref<HTMLDivElement>;
  shown: Shown;
  container: HTMLElement | null;
  baseUrl?: string;
  onEnter: () => void;
  onLeave: (e: React.MouseEvent) => void;
  onPin: (pinned: boolean) => void;
  onClose: () => void;
}

function Card({ cardRef, shown, container, baseUrl, onEnter, onLeave, onPin, onClose }: CardProps) {
  const metaMap = useJiraMeta();
  const { key, loaded, pinned } = shown;
  const detail = loaded && 'detail' in loaded ? loaded.detail : undefined;
  const meta = detail?.meta ?? metaMap[key];
  const trimmedBase = baseUrl?.trim().replace(/\/+$/, '');
  const href = trimmedBase ? `${trimmedBase}/browse/${encodeURIComponent(key)}` : undefined;

  const pos = cardPosition(shown.anchor, container, WIDTH, MAX_HEIGHT);

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
        <JiraTypeIcon type={meta?.type} />
        <span className={styles.key}>{key}</span>
        {meta?.status && (
          <span className={jiraStyles.chipStatus} data-cat={meta.statusCategory ?? 'unknown'}>{meta.status}</span>
        )}
        <span className={styles.spacer} />
        <CopyUrl url={href} className={styles.iconBtn} />
        {href && (
          <a className={styles.iconBtn} href={href} target="_blank" rel="noopener noreferrer" title="Open in Jira" aria-label="Open in Jira">
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
      {meta?.title && <div className={styles.title}>{meta.title}</div>}

      <div className={styles.scroll}>
        {!loaded && (
          <div className={styles.skeleton} aria-label="Loading">
            <span style={{ width: '92%' }} /><span style={{ width: '78%' }} /><span style={{ width: '85%' }} /><span style={{ width: '40%' }} />
          </div>
        )}
        {loaded && 'error' in loaded && <p className={styles.muted}>{errorText(loaded.error)}</p>}
        {detail && (
          <>
            <section className={styles.section}>
              <h4 className={styles.label}>Description</h4>
              {adfIsEmpty(detail.description)
                ? <p className={styles.muted}>No description</p>
                : (
                  <div className={styles.desc}>
                    <AdfView doc={detail.description!} />
                  </div>
                )}
            </section>
            <section className={styles.section}>
              <h4 className={styles.label}>
                Latest comment{detail.commentCount > 1 && <span className={styles.count}> · {detail.commentCount} total</span>}
              </h4>
              {detail.lastComment
                ? (
                  <div className={styles.comment}>
                    <div className={styles.commentMeta}>
                      <span className={styles.author}>{detail.lastComment.author ?? 'Unknown'}</span>
                      {detail.lastComment.created && (
                        <span title={new Date(detail.lastComment.created).toLocaleString()}>{relTime(detail.lastComment.created)}</span>
                      )}
                    </div>
                    {detail.lastComment.body && !adfIsEmpty(detail.lastComment.body)
                      ? <AdfView doc={detail.lastComment.body} />
                      : <p className={styles.muted}>Empty comment</p>}
                  </div>
                )
                : <p className={styles.muted}>No comments</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
