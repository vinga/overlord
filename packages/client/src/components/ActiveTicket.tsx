import { useJiraMeta } from '../hooks/useJiraMeta';
import { JiraTypeIcon } from './JiraTypeIcon';
import styles from './ActiveTicket.module.css';

interface Props {
  /** The session's front ticket — `jiraKeys[0]`. */
  ticketKey: string;
  baseUrl?: string;
}

/** The ticket the session works on, shown in the conversation header:
 *  type, key, title and Jira status. Links to Jira when the base URL is set. */
export function ActiveTicket({ ticketKey, baseUrl }: Props) {
  const m = useJiraMeta()[ticketKey];
  const base = baseUrl?.replace(/\/+$/, '');
  const href = base ? `${base}/browse/${encodeURIComponent(ticketKey)}` : undefined;
  const tip = [m?.type, ticketKey, m?.status].filter(Boolean).join(' · ');

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
    ? <a className={styles.ticket} href={href} target="_blank" rel="noopener noreferrer" title={tip}>{body}</a>
    : <div className={styles.ticket} title={tip}>{body}</div>;
}
