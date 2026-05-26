import React, { useState } from 'react';
import styles from './JiraChips.module.css';
import { useJiraMeta } from '../hooks/useJiraMeta';
import { JiraTypeIcon } from './JiraTypeIcon';

interface Props {
  keys: string[];
  baseUrl?: string;
  sessionId?: string;
}

const VISIBLE = 3;

export function JiraChips({ keys, baseUrl, sessionId }: Props) {
  const meta = useJiraMeta();
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState<Set<string>>(() => new Set());
  if (!keys || keys.length === 0) return null;

  const shown = keys.filter(k => !dismissing.has(k));
  if (shown.length === 0) return null;

  const visible = expanded ? shown : shown.slice(0, VISIBLE);
  const overflow = shown.length - VISIBLE;
  const trimmedBase = baseUrl?.replace(/\/+$/, '');

  const stop = (e: React.MouseEvent) => e.stopPropagation();

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
        // Status tooltip (e.g. "Bug · In Progress"); omitted when nothing resolved.
        const tip = [m?.type, m?.status].filter(Boolean).join(' · ') || undefined;
        const chipClass = `${styles.chip}${sessionId ? ' ' + styles.chipHasDismiss : ''}`;
        const content = (
          <>
            <JiraTypeIcon type={m?.type} />
            <span className={styles.chipKey}>{key}</span>
            {title && (
              <>
                <span className={styles.chipSep}>—</span>
                <span className={styles.chipTitle}>{title}</span>
              </>
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
        return isLink ? (
          <span key={key} className={styles.chipWrap}>
            <a
              className={chipClass}
              href={`${trimmedBase}/browse/${encodeURIComponent(key)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
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
              onClick={(e) => {
                e.stopPropagation();
                alert('Set the JIRA Base URL in Settings (gear icon) to make these chips clickable.\n\nExample: https://hypatos.atlassian.net');
              }}
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
