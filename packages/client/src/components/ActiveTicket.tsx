import { useEffect, useRef, useState } from 'react';
import { useJiraMeta } from '../hooks/useJiraMeta';
import { adoptJiraTicket, JIRA_DBLCLICK_MS } from '../lib/jiraAdopt';
import { JiraTypeIcon } from './JiraTypeIcon';
import styles from './ActiveTicket.module.css';

interface Props {
  /** The session's front ticket — `jiraKeys[0]`. */
  ticketKey: string;
  baseUrl?: string;
  sessionId: string;
  /** Optimistic rename path, as in JiraChips. */
  onRename?: (name: string) => void;
}

/** The ticket the session works on, shown in the conversation header:
 *  type, key, title and Jira status. Click opens Jira (when the base URL is
 *  set); double click names the session after the ticket and sets its icon. */
export function ActiveTicket({ ticketKey, baseUrl, sessionId, onRename }: Props) {
  const m = useJiraMeta()[ticketKey];
  const [adopted, setAdopted] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const base = baseUrl?.replace(/\/+$/, '');
  const href = base ? `${base}/browse/${encodeURIComponent(ticketKey)}` : undefined;
  const status = [m?.type, ticketKey, m?.status].filter(Boolean).join(' · ');
  const tip = `${status} — double-click to name this session after the ticket`;

  // Single click waits out the double-click window, so adopting never also opens a tab.
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!href) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      window.open(href, '_blank', 'noopener,noreferrer');
    }, JIRA_DBLCLICK_MS);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    adoptJiraTicket(sessionId, ticketKey, m, onRename);
    setAdopted(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setAdopted(false), 700);
  };

  const className = `${styles.ticket} ${href ? styles.link : ''} ${adopted ? styles.adopted : ''}`;
  const body = (
    <>
      <JiraTypeIcon type={m?.type} />
      {m?.type && <span className={styles.type}>{m.type}</span>}
      <span className={styles.key}>{ticketKey}</span>
      {m?.title && <span className={styles.title}>{m.title}</span>}
      {m?.status && (
        <span className={styles.status} data-cat={m.statusCategory ?? 'unknown'}>{m.status}</span>
      )}
    </>
  );

  return href
    ? <a className={className} href={href} target="_blank" rel="noopener noreferrer" title={tip} onClick={onClick} onDoubleClick={onDoubleClick}>{body}</a>
    : <div className={className} title={tip} onDoubleClick={onDoubleClick}>{body}</div>;
}
