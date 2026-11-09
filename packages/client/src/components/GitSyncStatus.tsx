import React from 'react';
import type { Room } from '../types';
import styles from './GitSyncStatus.module.css';

type Props = Pick<Room, 'gitAhead' | 'gitBehind' | 'gitUpstream' | 'gitDirty'>;

/** One line on how the room's branch stands against its remote: to push, to
 *  pull (as of the last fetch — nothing fetches here), uncommitted changes. */
export const GitSyncStatus = React.memo(function GitSyncStatus({ gitAhead = 0, gitBehind = 0, gitUpstream, gitDirty = 0 }: Props) {
  // Not read yet (server sweep pending) and nothing else known: say nothing.
  if (gitUpstream === undefined && !gitAhead && !gitBehind && !gitDirty) return null;

  const parts: React.ReactNode[] = [];
  if (gitUpstream === null) {
    parts.push(<span key="up" className={styles.warn} title="This branch tracks no remote branch">not on remote</span>);
  }
  if (gitAhead > 0) {
    parts.push(<span key="ahead" className={styles.ahead} title={`${gitAhead} local commit${gitAhead === 1 ? '' : 's'} not pushed`}>↑{gitAhead} to push</span>);
  }
  if (gitBehind > 0) {
    parts.push(<span key="behind" className={styles.behind} title={`${gitBehind} commit${gitBehind === 1 ? '' : 's'} on ${gitUpstream ?? 'the remote'} not pulled (as of the last fetch)`}>↓{gitBehind} to pull</span>);
  }
  if (gitDirty > 0) {
    parts.push(<span key="dirty" className={styles.dirty} title="Tracked files with uncommitted changes (untracked files not counted)">{gitDirty} uncommitted</span>);
  }
  if (gitUpstream && !gitAhead && !gitBehind) {
    parts.unshift(<span key="ok" className={styles.ok} title="As of the last fetch">up to date with {gitUpstream}</span>);
  }

  return (
    <div className={styles.line}>
      {parts.map((p, i) => <React.Fragment key={i}>{i > 0 && <span className={styles.sep}>·</span>}{p}</React.Fragment>)}
    </div>
  );
});
