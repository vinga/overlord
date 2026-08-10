import React, { useEffect, useRef, useState } from 'react';
import styles from './JiraChips.module.css';
import { useJiraMeta } from '../hooks/useJiraMeta';
import { JiraTypeIcon } from './JiraTypeIcon';
import { jiraSessionTitle, jiraTypeToWorkerIcon } from '../lib/jiraIcon';
import { ICON_COLORS } from './iconColors';

interface Props {
  keys: string[];
  baseUrl?: string;
  sessionId?: string;
  /** Optimistic rename path (same one the label editor uses). When absent the
   *  adopt gesture PUTs the name directly. */
  onRename?: (name: string) => void;
}

const VISIBLE = 3;

/** Single click opens JIRA, double click adopts the ticket. Navigation is held
 *  for this long so a double click never also opens a tab. */
const DBLCLICK_MS = 260;

export function JiraChips({ keys, baseUrl, sessionId, onRename }: Props) {
  const meta = useJiraMeta();
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState<Set<string>>(() => new Set());
  const [adopted, setAdopted] = useState<string | null>(null);
  // Pending single-click navigation, cancelled when a second click lands.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
  }, []);

  if (!keys || keys.length === 0) return null;

  const shown = keys.filter(k => !dismissing.has(k));
  if (shown.length === 0) return null;

  const visible = expanded ? shown : shown.slice(0, VISIBLE);
  const overflow = shown.length - VISIBLE;
  const trimmedBase = baseUrl?.replace(/\/+$/, '');

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const put = (path: string, body: unknown) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId!)}/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => {
      if (!r.ok) console.warn(`[jira-adopt] ${path} PUT failed`, r.status, sessionId);
    }).catch(e => console.warn(`[jira-adopt] ${path} PUT error`, e));

  // Adopt the ticket onto the session: title becomes "KEY Summary", and — only
  // when the JIRA issue type resolved — the avatar takes the matching glyph and
  // its paired colour. An undeducible type leaves icon and colour untouched.
  const adopt = (key: string) => {
    if (!sessionId) return;
    const m = meta?.[key];
    const name = jiraSessionTitle(key, m?.title);
    if (onRename) onRename(name);
    else void put('name', { name });

    const icon = jiraTypeToWorkerIcon(m?.type);
    if (icon) {
      void put('icon', { icon });
      void put('color', { color: ICON_COLORS[icon] });
    }

    setAdopted(key);
    setTimeout(() => setAdopted(prev => (prev === key ? null : prev)), 700);
  };

  const dismiss = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sessionId) return;
    setDismissing(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    void fetch(`/api/sessions/${sessionId}/jira-keys/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }).catch(() => {
      setDismissing(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });
  };

  return (
    <div className={styles.row} onClick={stop}>
      {visible.map((key) => {
        const isLink = !!trimmedBase;
        const m = meta?.[key];
        const title = m?.title;
        const href = trimmedBase ? `${trimmedBase}/browse/${encodeURIComponent(key)}` : undefined;
        // Status tooltip (e.g. "Bug · In Progress"); omitted when nothing resolved.
        const status = [m?.type, m?.status].filter(Boolean).join(' · ');
        const tip = sessionId
          ? [status, 'Double-click to name this session after the ticket'].filter(Boolean).join(' — ')
          : status || undefined;
        const chipClass = [
          styles.chip,
          sessionId ? styles.chipHasDismiss : '',
          adopted === key ? styles.adopted : '',
        ].filter(Boolean).join(' ');
        const content = (
          <>
            <JiraTypeIcon type={m?.type} />
            <span className={styles.chipKey}>{key}</span>
            {title && <span className={styles.chipTitle}>{title}</span>}
            {m?.status && (
              <span className={styles.chipStatus} data-cat={m.statusCategory ?? 'unknown'}>
                {m.status}
              </span>
            )}
          </>
        );
        const dismissBtn = sessionId ? (
          <button
            type="button"
            className={styles.dismiss}
            onClick={(e) => dismiss(e, key)}
            aria-label={`Dismiss ${key}`}
          >
            ×
          </button>
        ) : null;
        // Defer the single-click action past the double-click window, otherwise
        // adopting a ticket also fires the click action (opening a JIRA tab, or
        // popping the "configure me" alert — which would block the dblclick).
        const deferSingleClick = (e: React.MouseEvent, action: () => void) => {
          e.preventDefault();
          e.stopPropagation();
          if (!sessionId) { action(); return; }
          if (clickTimer.current) clearTimeout(clickTimer.current);
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null;
            action();
          }, DBLCLICK_MS);
        };
        const onChipDoubleClick = (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (clickTimer.current) {
            clearTimeout(clickTimer.current);
            clickTimer.current = null;
          }
          adopt(key);
        };
        return isLink ? (
          <span key={key} className={styles.chipWrap}>
            <a
              className={chipClass}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => deferSingleClick(e, () => window.open(href!, '_blank', 'noopener,noreferrer'))}
              onDoubleClick={onChipDoubleClick}
              title={tip}
            >
              {content}
              {dismissBtn}
            </a>
          </span>
        ) : (
          <span key={key} className={styles.chipWrap}>
            <button
              type="button"
              className={`${chipClass} ${styles.chipUnconfigured}`}
              title={tip}
              onClick={(e) => deferSingleClick(e, () => {
                alert('Set the JIRA Base URL in Settings (gear icon) to make these chips clickable.\n\nExample: https://hypatos.atlassian.net');
              })}
              onDoubleClick={onChipDoubleClick}
            >
              {content}
              {dismissBtn}
            </button>
          </span>
        );
      })}
      {!expanded && overflow > 0 && (
        <button
          type="button"
          className={styles.more}
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        >
          +{overflow}
        </button>
      )}
      {expanded && shown.length > VISIBLE && (
        <button
          type="button"
          className={styles.more}
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        >
          show less
        </button>
      )}
    </div>
  );
}
