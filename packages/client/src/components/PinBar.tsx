import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { JiraIssueMeta, Pin, PinKind } from '../types';
import styles from './PinBar.module.css';
import jiraStyles from './JiraChips.module.css';
import { JiraTypeIcon } from './JiraTypeIcon';
import { useJiraMeta } from '../hooks/useJiraMeta';
import { adoptJiraTicket, JIRA_DBLCLICK_MS } from '../lib/jiraAdopt';

/** Jira key of a ticket pin — mirrors server `jiraKeyOfPin`. */
export function jiraKeyOf(pin: Pin): string | undefined {
  if (pin.kind !== 'ticket') return undefined;
  try {
    const u = new URL(pin.url);
    const m = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/);
    if (m) return m[1];
    const sel = u.searchParams.get('selectedIssue');
    return sel && /^[A-Z][A-Z0-9_]*-\d+$/.test(sel) ? sel : undefined;
  } catch {
    return undefined;
  }
}

/** `https://github.com/o/r/pull/N…` → `o/r#n` (lowercased; GitHub refs are case-insensitive). */
function prRefOfUrl(url: string | undefined): string | undefined {
  const m = url?.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  return m ? `${m[1]}#${m[2]}`.toLowerCase() : undefined;
}

/** Identity used to drop pins already shown elsewhere: `jira:KEY` or `pr:o/r#n`. */
export function pinRef(pin: Pin): string | undefined {
  const key = jiraKeyOf(pin);
  if (key) return `jira:${key}`;
  if (pin.kind === 'pr') {
    const ref = prRefOfUrl(pin.url);
    return ref ? `pr:${ref}` : undefined;
  }
  return undefined;
}

/** The refs a PinBar should leave out, joined into one string so it is a
 *  primitive prop. `prRefs` are `owner/repo#N`; `prUrl` a GitHub PR URL. */
export function hiddenPinRefs(jiraKeys?: string[], prRefs?: string[], prUrl?: string): string {
  const out: string[] = [];
  for (const k of jiraKeys ?? []) out.push(`jira:${k}`);
  for (const r of prRefs ?? []) out.push(`pr:${r.toLowerCase()}`);
  const fromUrl = prRefOfUrl(prUrl);
  if (fromUrl) out.push(`pr:${fromUrl}`);
  return out.join('\n');
}

/** Octicon-style 16px glyphs, filled with currentColor. */
export function KindIcon({ kind }: { kind: PinKind }) {
  const common = {
    className: styles.icon,
    width: 12,
    height: 12,
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': true,
  } as const;
  switch (kind) {
    case 'text':
      return (
        <svg {...common}>
          <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h2A1.5 1.5 0 0 1 8 4.5v2a3.5 3.5 0 0 1-3.5 3.5.75.75 0 0 1 0-1.5 2 2 0 0 0 1.9-1.5H4.5A1.5 1.5 0 0 1 3 5.5zm6 0A1.5 1.5 0 0 1 10.5 3h2A1.5 1.5 0 0 1 14 4.5v2a3.5 3.5 0 0 1-3.5 3.5.75.75 0 0 1 0-1.5 2 2 0 0 0 1.9-1.5h-1.9A1.5 1.5 0 0 1 9 5.5z" />
        </svg>
      );
    case 'pr':
      return (
        <svg {...common}>
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </svg>
      );
    case 'branch':
      return (
        <svg {...common}>
          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
        </svg>
      );
    case 'ticket':
      return (
        <svg {...common}>
          <path d="M1.5 4.25c0-.966.784-1.75 1.75-1.75h9.5c.966 0 1.75.784 1.75 1.75v1.5a.75.75 0 0 1-.75.75 1.5 1.5 0 0 0 0 3 .75.75 0 0 1 .75.75v1.5a1.75 1.75 0 0 1-1.75 1.75h-9.5a1.75 1.75 0 0 1-1.75-1.75v-1.5a.75.75 0 0 1 .75-.75 1.5 1.5 0 0 0 0-3 .75.75 0 0 1-.75-.75Zm1.75-.25a.25.25 0 0 0-.25.25v.946a3.001 3.001 0 0 1 0 5.608v.946c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-.946a3.001 3.001 0 0 1 0-5.608V4.25a.25.25 0 0 0-.25-.25Zm7.5 1.25v5.5a.75.75 0 0 1-1.5 0v-5.5a.75.75 0 0 1 1.5 0Z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z" />
        </svg>
      );
  }
}

interface ChipProps {
  href: string;
  /** A Jira key: renders type badge + key + summary + status lozenge. */
  jiraKey?: string;
  jiraMeta?: JiraIssueMeta;
  /** Plain chips: the kind icon and label. Ticket chips: a custom summary
   *  that wins over the Jira title. */
  kind?: PinKind;
  label?: string;
  onRemove: () => void;
  removeLabel: string;
  /** Ticket chips: double click names the session after the ticket (title +
   *  icon), like JiraChips; single click opens Jira after the dblclick window. */
  onAdopt?: () => void;
  /** Text pins: the pinned text (rendered as a quote, not a link). */
  text?: string;
  /** Text pins: full quote card (clamped, expandable) instead of a one-line chip. */
  multiline?: boolean;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;

/** Text with its http(s) URLs as links that open in a new tab. */
function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <a key={i} className={styles.quoteLink} href={m[0]} target="_blank" rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}>{m[0]}</a>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A pinned piece of text: a quote card in the context column (4 lines,
 *  click to expand, copy + ×), a one-line chip elsewhere. */
function TextPinChip({ text, label, onRemove, removeLabel, multiline }: { text: string; label?: string; onRemove: () => void; removeLabel: string; multiline?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };
  return (
    <span className={`${styles.chip} ${styles.chipText} ${multiline ? styles.chipTextCard : ''}`} data-kind="text">
      {multiline ? (
        // A div, not a button: it holds real links. Click toggles; a link click opens.
        <div
          role="button"
          tabIndex={0}
          className={`${styles.quote} ${expanded ? styles.quoteOpen : ''}`}
          onClick={() => setExpanded(v => !v)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v); } }}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {linkify(text)}
        </div>
      ) : (
        <span className={styles.link} title={text}>
          <KindIcon kind="text" />
          <span className={styles.label}>{label || text}</span>
        </span>
      )}
      {multiline && (
        <button type="button" className={styles.copy} onClick={copy} aria-label="Copy pinned text" title="Copy">
          {copied ? '✓' : '⧉'}
        </button>
      )}
      <button
        type="button"
        className={styles.remove}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
        aria-label={removeLabel}
        title={removeLabel}
      >
        ×
      </button>
    </span>
  );
}

/** One chip: a Jira ticket (rich) or any other link. × calls `onRemove`. */
export function PinChip(props: ChipProps) {
  if (props.kind === 'text' && props.text !== undefined) {
    return <TextPinChip text={props.text} label={props.label} onRemove={props.onRemove} removeLabel={props.removeLabel} multiline={props.multiline} />;
  }
  return <LinkPinChip {...props} />;
}

function LinkPinChip({ href, jiraKey, jiraMeta: m, kind = 'link', label, onRemove, removeLabel, onAdopt }: ChipProps) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current); }, []);
  const adoptable = !!(jiraKey && onAdopt);
  const onClick = adoptable ? (e: React.MouseEvent) => {
    e.preventDefault();
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      window.open(href, '_blank', 'noopener,noreferrer');
    }, JIRA_DBLCLICK_MS);
  } : undefined;
  const onDoubleClick = adoptable ? (e: React.MouseEvent) => {
    e.preventDefault();
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    onAdopt!();
  } : undefined;
  const summary = jiraKey && label && label !== jiraKey ? label : m?.title;
  const tip = [jiraKey && [m?.type, m?.status].filter(Boolean).join(' · '), jiraKey ? summary : label, href]
    .filter(Boolean).join('\n');
  return (
    <span className={`${styles.chip} ${jiraKey ? styles.chipJira : ''}`} data-kind={jiraKey ? 'ticket' : kind}>
      <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer"
        title={adoptable ? `${tip}\nDouble-click to name this session after the ticket` : tip}
        onClick={onClick} onDoubleClick={onDoubleClick}>
        {jiraKey ? (
          <>
            <JiraTypeIcon type={m?.type} />
            <span className={styles.key}>{jiraKey}</span>
            {summary && <span className={`${styles.label} ${styles.summary}`}>{summary}</span>}
            {m?.status && (
              <span className={jiraStyles.chipStatus} data-cat={m.statusCategory ?? 'unknown'}>{m.status}</span>
            )}
          </>
        ) : (
          <>
            <KindIcon kind={kind} />
            <span className={styles.label}>{label || href}</span>
          </>
        )}
      </a>
      <button
        type="button"
        className={styles.remove}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
        aria-label={removeLabel}
        title={removeLabel}
      >
        ×
      </button>
    </span>
  );
}

/** Unpin by id from a session or room. */
export function deletePin(pinId: string, target: { overlordId?: string; cwd?: string }): void {
  const q = target.overlordId !== undefined
    ? `overlordId=${encodeURIComponent(target.overlordId)}`
    : `cwd=${encodeURIComponent(target.cwd ?? '')}`;
  void fetch(`/api/pins/${encodeURIComponent(pinId)}?${q}`, { method: 'DELETE' }).catch(() => {});
}

/** "+" that turns into a URL input; POSTs a pin to the session (overlordId) or room (cwd). */
export function PinAdder({ overlordId, cwd }: { overlordId?: string; cwd?: string }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const targetKey = overlordId ?? cwd;

  // A different session/room — drop any half-typed draft.
  useEffect(() => {
    setAdding(false);
    setUrl('');
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const cancel = () => {
    setAdding(false);
    setUrl('');
    setError(null);
  };

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(overlordId !== undefined ? { overlordId } : { cwd }), url: trimmed }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? `Failed (${r.status})`);
        return;
      }
      cancel();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {adding ? (
        <input
          ref={inputRef}
          className={`${styles.input} ${error ? styles.inputError : ''}`}
          value={url}
          placeholder="Paste a URL…"
          disabled={busy}
          onChange={(e) => { setUrl(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
          }}
          onBlur={() => { if (!url.trim()) cancel(); }}
        />
      ) : (
        <button
          type="button"
          className={styles.add}
          onClick={() => setAdding(true)}
          title="Pin a link"
          aria-label="Pin a link"
        >
          +
        </button>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </>
  );
}

/** Exactly one of overlordId / cwd. Primitives, not a target object, so the
 *  React.memo shallow compare holds across WebSocket ticks. */
type Props = {
  pins: Pin[] | undefined;
  /** From `hiddenPinRefs` — pins already shown elsewhere on screen. */
  hide?: string;
  /** Chips wrap their title over several lines instead of truncating, and the
   *  bar drops its side padding — for a card, not a header strip. */
  multiline?: boolean;
  /** Session whose title/icon a double-clicked ticket chip sets. */
  adoptSessionId?: string;
} & (
  | { overlordId: string; cwd?: undefined }
  | { cwd: string; overlordId?: undefined }
);

/** Links pinned to a room — one wrapping row of chips above the tab bar.
 *  Hidden when empty (the first pin is added via the CLI). The snapshot
 *  rebroadcasts after every change, so there is no local copy of the list. */
export const PinBar = React.memo(function PinBar({ pins: allPins, hide, multiline = false, adoptSessionId, overlordId, cwd }: Props) {
  const pins = useMemo(() => {
    if (!allPins || !hide) return allPins;
    const hidden = new Set(hide.split('\n'));
    if (!allPins.some((p) => { const r = pinRef(p); return r !== undefined && hidden.has(r); })) return allPins;
    return allPins.filter((p) => { const r = pinRef(p); return r === undefined || !hidden.has(r); });
  }, [allPins, hide]);
  const jiraMeta = useJiraMeta();

  if (!pins || pins.length === 0) return null;

  return (
    <div className={`${styles.bar} ${multiline ? styles.multiline : ''}`}>
      <div className={styles.row}>
        {pins.map((pin) => {
          const key = jiraKeyOf(pin);
          return (
            <PinChip
              key={pin.id}
              href={pin.url}
              jiraKey={key}
              jiraMeta={key ? jiraMeta[key] : undefined}
              kind={pin.kind}
              label={pin.title}
              onRemove={() => deletePin(pin.id, { overlordId, cwd })}
              removeLabel={`Unpin ${pin.title || pin.url}`}
              text={pin.text}
              multiline={multiline}
              onAdopt={key && adoptSessionId ? () => adoptJiraTicket(adoptSessionId, key, jiraMeta[key]) : undefined}
            />
          );
        })}
        <PinAdder overlordId={overlordId} cwd={cwd} />
      </div>
    </div>
  );
});
