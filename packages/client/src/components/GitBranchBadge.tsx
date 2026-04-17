import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styles from './GitBranchBadge.module.css';

interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
  stashCount: number;
  lastCommit: { hash: string; subject: string; author: string; relativeTime: string } | null;
  unpushedCommits: Array<{ hash: string; subject: string; relativeTime: string }>;
  pullRequest: { number: number; url: string; title: string; state: string; isDraft: boolean } | null;
}

interface Props {
  branch: string;
  cwd: string;
  aheadBehind?: { ahead: number; behind: number; base: string | null };
  gitWarning?: string;
  pullRequest?: { number: number; url: string; title: string; state: string; isDraft: boolean };
}

export function GitBranchBadge({ branch, cwd, aheadBehind, gitWarning, pullRequest }: Props) {
  const prResolved = pullRequest?.state === 'MERGED' || pullRequest?.state === 'CLOSED';
  const showAheadBehind = !prResolved && !!aheadBehind;
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'bottom' | 'top' } | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0);

  const open = hover || pinned;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (tooltipRef.current?.contains(t)) return;
      if (spanRef.current?.contains(t)) return;
      setPinned(false);
      setHover(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPinned(false); setHover(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  useEffect(() => {
    if (!open) return;
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: GitStatus) => {
        if (id !== fetchIdRef.current) return;
        setStatus(data);
        setLoading(false);
      })
      .catch(err => {
        if (id !== fetchIdRef.current) return;
        setError(err.message);
        setLoading(false);
      });
  }, [open, cwd, branch]);

  const handleEnter = (e: React.MouseEvent<HTMLSpanElement>) => {
    setAnchor(e.currentTarget.getBoundingClientRect());
    setPos(null);
    setHover(true);
  };

  const handleBadgeClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget.getBoundingClientRect());
    setPinned(p => !p);
  };

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const el = tooltipRef.current;
    if (!el) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { width, height } = el.getBoundingClientRect();
    const anchorCenter = anchor.left + anchor.width / 2;

    let left = anchorCenter - width / 2;
    left = Math.max(margin, Math.min(left, vw - width - margin));

    const spaceBelow = vh - anchor.bottom;
    const placement: 'bottom' | 'top' = spaceBelow >= height + margin + 6 || spaceBelow >= vh / 2
      ? 'bottom'
      : 'top';
    let top = placement === 'bottom' ? anchor.bottom + 6 : anchor.top - height - 6;
    top = Math.max(margin, Math.min(top, vh - height - margin));

    setPos({ left, top, placement });
  }, [open, anchor, status, loading, error]);

  return (
    <div className={styles.wrap}>
      <span
        ref={spanRef}
        className={styles.badge}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setHover(false)}
        onClick={handleBadgeClick}
        title={gitWarning ?? undefined}
      >
        <BranchIcon className={styles.icon}/>
        <span className={styles.branchText}>{branch}</span>
        {showAheadBehind && aheadBehind!.ahead > 0 && (
          <span className={styles.pillAhead} title={`${aheadBehind!.ahead} commits ahead of ${aheadBehind!.base ?? 'base'}`}>↑{aheadBehind!.ahead}</span>
        )}
        {showAheadBehind && aheadBehind!.behind > 0 && (
          <span className={styles.pillBehind} title={`${aheadBehind!.behind} commits behind ${aheadBehind!.base ?? 'base'}`}>↓{aheadBehind!.behind}</span>
        )}
        {gitWarning && (
          <span className={styles.pillWarn} title={gitWarning} aria-label="Git warning">!</span>
        )}
      </span>
      {pullRequest && (
        <a
          className={`${styles.pillPr} ${prStateClass(pullRequest)}`}
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          title={`Open PR #${pullRequest.number} · ${pullRequest.isDraft ? 'Draft' : pullRequest.state}\n${pullRequest.title}`}
        >
          <PullRequestIcon/>
          <span>#{pullRequest.number}</span>
        </a>
      )}
      {open && ReactDOM.createPortal(
        <div
          ref={tooltipRef}
          className={`${styles.tooltip} ${pinned ? styles.tooltipPinned : ''}`}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => { if (!pinned) setHover(false); }}
        >
          <TooltipBody branch={branch} status={status} loading={loading} error={error} gitWarning={gitWarning} aheadBehind={showAheadBehind ? aheadBehind : undefined} prResolved={prResolved} />
        </div>,
        document.body
      )}
    </div>
  );
}

function BranchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3" r="1.5"/>
      <circle cx="4" cy="13" r="1.5"/>
      <circle cx="12" cy="6" r="1.5"/>
      <path d="M4 4.5v7"/>
      <path d="M12 7.5c0 3-4 2.5-4 5"/>
    </svg>
  );
}

function PullRequestIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3" r="1.5"/>
      <circle cx="4" cy="13" r="1.5"/>
      <circle cx="12" cy="13" r="1.5"/>
      <path d="M4 4.5v7"/>
      <path d="M12 3v8.5"/>
      <path d="M12 3h-2"/>
      <path d="M10 1.5L8.5 3 10 4.5"/>
    </svg>
  );
}

function CommitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3"/>
      <path d="M1.5 8H5"/>
      <path d="M11 8h3.5"/>
    </svg>
  );
}

function UnpushedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="11.5" r="2.5"/>
      <path d="M8 8V2"/>
      <path d="M5.5 4.5L8 2l2.5 2.5"/>
    </svg>
  );
}

function prStateClass(pr: { state: string; isDraft: boolean }): string {
  if (pr.isDraft) return styles.pillPrDraft;
  if (pr.state === 'MERGED') return styles.pillPrMerged;
  if (pr.state === 'CLOSED') return styles.pillPrClosed;
  return styles.pillPrOpen;
}

function TooltipBody({ branch, status, loading, error, gitWarning, aheadBehind, prResolved }: { branch: string; status: GitStatus | null; loading: boolean; error: string | null; gitWarning?: string; aheadBehind?: { ahead: number; behind: number; base: string | null }; prResolved?: boolean }) {
  if (error) {
    return (
      <>
        {gitWarning && <WarningBanner text={gitWarning}/>}
        <div className={styles.emptyNote}>Git status unavailable</div>
      </>
    );
  }
  if (loading && !status) {
    return (
      <>
        {gitWarning && <WarningBanner text={gitWarning}/>}
        <div className={styles.header}>
          <BranchHeading branch={branch} upstream={null} ahead={0} behind={0} aheadBehind={aheadBehind} />
        </div>
        <div className={styles.shimmerBlock}/>
        <div className={styles.shimmerBlock}/>
      </>
    );
  }
  if (!status) return null;
  const cleanWorking = status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0 && status.conflicted.length === 0;
  return (
    <>
      {gitWarning && <WarningBanner text={gitWarning}/>}
      <div className={styles.header}>
        <BranchHeading branch={status.branch ?? branch} upstream={status.upstream} ahead={status.ahead} behind={status.behind} aheadBehind={aheadBehind} />
      </div>
      {status.pullRequest && (
        <PrRow pr={status.pullRequest}/>
      )}
      {status.lastCommit && (() => {
        const lastIsUnpushed = status.unpushedCommits.some(c => c.hash === status.lastCommit!.hash);
        const lastLabel = lastIsUnpushed
          ? { text: 'Unpushed', cls: styles.statusUnpushed }
          : status.upstream
            ? { text: 'Pushed', cls: styles.statusPushed }
            : null;
        return (
          <div className={styles.commitRow}>
            <div className={styles.commitMeta}>
              <CommitIcon className={styles.commitIcon}/>
              <span className={styles.commitHash}>{status.lastCommit.hash}</span>
              <span className={styles.commitAuthor}>{status.lastCommit.author}</span>
              <span className={styles.commitTime}>· {status.lastCommit.relativeTime}</span>
              {lastLabel && <span className={`${styles.commitStatus} ${lastLabel.cls}`}>{lastLabel.text}</span>}
            </div>
            <div className={styles.commitSubject}>{status.lastCommit.subject}</div>
          </div>
        );
      })()}
      {status.unpushedCommits.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <UnpushedIcon className={styles.sectionIcon}/>
            <span className={styles.sectionLabel}>Unpushed</span>
            <span className={styles.sectionCount}>{status.unpushedCommits.length}</span>
          </div>
          <ul className={styles.commitList}>
            {status.unpushedCommits.slice(0, 8).map(c => (
              <li key={c.hash} className={styles.commitItem}>
                <CommitIcon className={styles.commitItemIcon}/>
                <span className={styles.commitHash}>{c.hash}</span>
                <span className={styles.commitItemSubject}>{c.subject}</span>
                <span className={styles.commitTime}>{c.relativeTime}</span>
              </li>
            ))}
            {status.unpushedCommits.length > 8 && (
              <li className={styles.fileMore}>+{status.unpushedCommits.length - 8} more…</li>
            )}
          </ul>
        </div>
      )}
      {cleanWorking ? (
        <div className={styles.cleanRow}>
          <span className={styles.cleanDot}/>
          Working tree clean
        </div>
      ) : (
        <div className={styles.sections}>
          {status.conflicted.length > 0 && (
            <FileSection label="Conflicted" dotClass={styles.dotConflict} files={status.conflicted}/>
          )}
          {status.staged.length > 0 && (
            <FileSection label="Staged" dotClass={styles.dotStaged} files={status.staged}/>
          )}
          {status.modified.length > 0 && (
            <FileSection label="Modified" dotClass={styles.dotModified} files={status.modified}/>
          )}
          {status.untracked.length > 0 && (
            <FileSection label="Untracked" dotClass={styles.dotUntracked} files={status.untracked}/>
          )}
        </div>
      )}
      {status.stashCount > 0 && (
        <div className={styles.footer}>
          {status.stashCount} stash{status.stashCount === 1 ? '' : 'es'}
        </div>
      )}
    </>
  );
}

function PrRow({ pr }: { pr: NonNullable<GitStatus['pullRequest']> }) {
  const stateClass =
    pr.isDraft ? styles.prStateDraft :
    pr.state === 'MERGED' ? styles.prStateMerged :
    pr.state === 'CLOSED' ? styles.prStateClosed :
    styles.prStateOpen;
  const stateLabel = pr.isDraft ? 'Draft' : pr.state.charAt(0) + pr.state.slice(1).toLowerCase();
  return (
    <a className={styles.prRow} href={pr.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
      <span className={styles.prIcon}><PullRequestIcon/></span>
      <span className={`${styles.prState} ${stateClass}`}>{stateLabel}</span>
      <span className={styles.prNumber}>#{pr.number}</span>
      <span className={styles.prTitle}>{pr.title}</span>
    </a>
  );
}

function WarningBanner({ text }: { text: string }) {
  return (
    <div className={styles.warningBanner} role="alert">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 1.5l7 12.5H1z"/>
        <path d="M8 6v4"/>
        <circle cx="8" cy="12" r="0.6" fill="currentColor" stroke="none"/>
      </svg>
      <span>{text}</span>
    </div>
  );
}

function BranchHeading({ branch, upstream, ahead, behind, aheadBehind }: { branch: string; upstream: string | null; ahead: number; behind: number; aheadBehind?: { ahead: number; behind: number; base: string | null } }) {
  const sameNameUpstream = upstream && /^[^/]+\/(.+)$/.exec(upstream)?.[1] === branch;
  const baseLabel = aheadBehind?.base;
  return (
    <div className={styles.branchHeading}>
      <BranchIcon className={styles.branchHeadingIcon}/>
      <span className={styles.branchNameBig}>{branch}</span>
      {!upstream && (
        <span className={styles.noRemote} title="No upstream branch — changes have never been pushed">No remote</span>
      )}
      {upstream && !sameNameUpstream && (
        <span className={styles.upstream}>→ {upstream}</span>
      )}
      <span className={styles.abBadges}>
        {upstream && (ahead > 0 || behind > 0) && (
          <span className={styles.abGroup} title={`Relative to upstream ${upstream}`}>
            <span className={styles.abLabel}>vs upstream</span>
            {ahead > 0 && <span className={styles.aheadBadge}>↑{ahead}</span>}
            {behind > 0 && <span className={styles.behindBadge}>↓{behind}</span>}
          </span>
        )}
        {baseLabel && (aheadBehind!.ahead > 0 || aheadBehind!.behind > 0) && (
          <span className={styles.abGroup} title={`Relative to ${baseLabel}`}>
            <span className={styles.abLabel}>vs {baseLabel}</span>
            {aheadBehind!.ahead > 0 && <span className={styles.aheadBadge}>↑{aheadBehind!.ahead}</span>}
            {aheadBehind!.behind > 0 && <span className={styles.behindBadge}>↓{aheadBehind!.behind}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

function FileSection({ label, dotClass, files }: { label: string; dotClass: string; files: string[] }) {
  const MAX = 10;
  const shown = files.slice(0, MAX);
  const remaining = files.length - shown.length;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={`${styles.dot} ${dotClass}`}/>
        <span className={styles.sectionLabel}>{label}</span>
        <span className={styles.sectionCount}>{files.length}</span>
      </div>
      <ul className={styles.fileList}>
        {shown.map(f => <li key={f} className={styles.fileItem}>{f}</li>)}
        {remaining > 0 && <li className={styles.fileMore}>+{remaining} more…</li>}
      </ul>
    </div>
  );
}
