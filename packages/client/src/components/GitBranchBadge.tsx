import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styles from './GitBranchBadge.module.css';

interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base: string | null;
  baseAhead: number;
  baseBehind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
  stashCount: number;
  lastCommit: { hash: string; subject: string; author: string; relativeTime: string; filesChanged: number } | null;
  branchCommits: Array<{ hash: string; subject: string; relativeTime: string; filesChanged: number; pushed: boolean }>;
  modifiedCount: number;
  addedCount: number;
}

interface PrInfo { number: number; url: string; title: string; state: string; isDraft: boolean }
type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPED' | 'CANCELLED' | 'NEUTRAL';
interface Check { name: string; state: CheckState; url?: string; elapsed?: string }
interface PrData { pullRequest: PrInfo | null; checks: Check[]; mergeable: string | null; error: string | null }

interface Props {
  branch: string;
  cwd: string;
  gitWarning?: string;
  pullRequest?: { number: number; url: string; title: string; state: string; isDraft: boolean };
  gitAhead?: number;
}

export function GitBranchBadge({ branch, cwd, gitWarning, pullRequest, gitAhead }: Props) {
  const prResolved = pullRequest?.state === 'MERGED' || pullRequest?.state === 'CLOSED';
  const [pinned, setPinned] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'bottom' | 'top' } | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prData, setPrData] = useState<PrData | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0);

  const open = pinned;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (tooltipRef.current?.contains(t)) return;
      if (spanRef.current?.contains(t)) return;
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
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
    setPrLoading(true);
    setPrError(null);

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

    fetch(`/api/git/pr?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: PrData) => {
        if (id !== fetchIdRef.current) return;
        setPrData(data);
        setPrLoading(false);
      })
      .catch(err => {
        if (id !== fetchIdRef.current) return;
        setPrError(err.message);
        setPrLoading(false);
      });
  }, [open, cwd, branch]);

  const handleBadgeClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget.getBoundingClientRect());
    setPos(null);
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
        onClick={handleBadgeClick}
        title={gitWarning ?? undefined}
      >
        <BranchIcon className={styles.icon}/>
        <span className={styles.branchText}>{branch}</span>
        {(gitAhead ?? 0) > 0 && (
          <span className={styles.aheadPill} title={`${gitAhead} unpushed commit${gitAhead === 1 ? '' : 's'}`}>+{gitAhead}</span>
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
        >
          <TooltipBody
            branch={branch}
            status={status}
            loading={loading}
            error={error}
            gitWarning={gitWarning}
            prResolved={prResolved}
            prData={prData}
            prLoading={prLoading}
            prError={prError}
          />
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

function prStateClass(pr: { state: string; isDraft: boolean }): string {
  if (pr.isDraft) return styles.pillPrDraft;
  if (pr.state === 'MERGED') return styles.pillPrMerged;
  if (pr.state === 'CLOSED') return styles.pillPrClosed;
  return styles.pillPrOpen;
}

function TooltipBody({ branch, status, loading, error, gitWarning, prResolved, prData, prLoading, prError }: { branch: string; status: GitStatus | null; loading: boolean; error: string | null; gitWarning?: string; prResolved?: boolean; prData: PrData | null; prLoading: boolean; prError: string | null }) {
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
          <BranchHeading branch={branch} upstream={null} ahead={0} behind={0} base={null} baseAhead={0} baseBehind={0} prResolved={prResolved} />
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
        <BranchHeading branch={status.branch ?? branch} upstream={status.upstream} ahead={status.ahead} behind={status.behind} base={status.base} baseAhead={status.baseAhead} baseBehind={status.baseBehind} prResolved={prResolved} />
        {(status.modifiedCount > 0 || status.addedCount > 0) && (
          <div className={styles.fileSummary}>
            {status.modifiedCount > 0 && <span className={styles.fileSummaryModified}>{status.modifiedCount} modified</span>}
            {status.addedCount > 0 && <span className={styles.fileSummaryAdded}>{status.addedCount} added</span>}
          </div>
        )}
      </div>
      <PrBlock prData={prData} prLoading={prLoading} prError={prError} />
      {status.branchCommits.length > 0 && (
        <CommitsSection commits={status.branchCommits} />
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

function PrBlock({ prData, prLoading, prError }: { prData: PrData | null; prLoading: boolean; prError: string | null }) {
  if (prLoading && !prData) {
    return <div className={styles.shimmerBlock}/>;
  }
  if (prError) {
    return <div className={styles.emptyNote}>PR info unavailable</div>;
  }
  if (!prData?.pullRequest) return null;
  return (
    <>
      <PrRow pr={prData.pullRequest} mergeable={prData.mergeable} />
      {prData.checks.length > 0 && <ChecksSection checks={prData.checks} />}
    </>
  );
}

function PrRow({ pr, mergeable }: { pr: PrInfo; mergeable: string | null }) {
  const stateClass =
    pr.isDraft ? styles.prStateDraft :
    pr.state === 'MERGED' ? styles.prStateMerged :
    pr.state === 'CLOSED' ? styles.prStateClosed :
    styles.prStateOpen;
  const stateLabel = pr.isDraft ? 'Draft' : pr.state.charAt(0) + pr.state.slice(1).toLowerCase();
  const mergeLabel = mergeableLabel(mergeable);
  return (
    <a className={styles.prRow} href={pr.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
      <span className={styles.prIcon}><PullRequestIcon/></span>
      <span className={styles.rowKind}>PR</span>
      <span className={`${styles.prState} ${stateClass}`}>{stateLabel}</span>
      <span className={styles.prNumber}>#{pr.number}</span>
      <span className={styles.prTitle}>{pr.title}</span>
      {mergeLabel && <span className={`${styles.prMergeable} ${mergeLabel.cls}`}>{mergeLabel.text}</span>}
    </a>
  );
}

function mergeableLabel(mergeable: string | null): { text: string; cls: string } | null {
  if (!mergeable) return null;
  const s = mergeable.toUpperCase();
  if (s === 'CLEAN' || s === 'MERGEABLE') return { text: 'Mergeable', cls: styles.prMergeableOk };
  if (s === 'HAS_HOOKS' || s === 'UNSTABLE') return { text: 'Unstable', cls: styles.prMergeableWarn };
  if (s === 'BLOCKED' || s === 'BEHIND') return { text: 'Blocked', cls: styles.prMergeableWarn };
  if (s === 'DIRTY' || s === 'CONFLICTING') return { text: 'Conflicts', cls: styles.prMergeableBad };
  if (s === 'DRAFT') return { text: 'Draft', cls: styles.prMergeableWarn };
  return null;
}

function ChecksSection({ checks }: { checks: Check[] }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED = 5;
  const shown = expanded ? checks : checks.slice(0, COLLAPSED);
  const hidden = checks.length - shown.length;
  const pass = checks.filter(c => c.state === 'SUCCESS').length;
  const fail = checks.filter(c => c.state === 'FAILURE' || c.state === 'CANCELLED').length;
  const pending = checks.filter(c => c.state === 'PENDING').length;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <CheckIcon className={styles.sectionIcon}/>
        <span className={styles.sectionLabel}>Checks</span>
        <span className={styles.sectionCount}>{checks.length}</span>
        {fail > 0 && <span className={styles.checksFailBadge}>{fail} failing</span>}
        {fail === 0 && pending > 0 && <span className={styles.checksPendingBadge}>{pending} pending</span>}
        {fail === 0 && pending === 0 && pass > 0 && <span className={styles.checksPassBadge}>{pass}/{checks.length} passing</span>}
      </div>
      <ul className={styles.checkList}>
        {shown.map((c, i) => (
          <li key={`${c.name}-${i}`} className={styles.checkItem}>
            <span className={`${styles.checkDot} ${checkDotClass(c.state)}`} title={c.state}/>
            {c.url ? (
              <a className={styles.checkName} href={c.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{c.name}</a>
            ) : (
              <span className={styles.checkName}>{c.name}</span>
            )}
            {c.elapsed && <span className={styles.checkElapsed}>{c.elapsed}</span>}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button className={styles.expandButton} onClick={() => setExpanded(true)}>Show {hidden} more</button>
      )}
      {expanded && checks.length > COLLAPSED && (
        <button className={styles.expandButton} onClick={() => setExpanded(false)}>Collapse</button>
      )}
    </div>
  );
}

function checkDotClass(state: CheckState): string {
  switch (state) {
    case 'SUCCESS': return styles.checkDotPass;
    case 'FAILURE':
    case 'CANCELLED': return styles.checkDotFail;
    case 'PENDING': return styles.checkDotPending;
    case 'SKIPPED':
    case 'NEUTRAL': return styles.checkDotNeutral;
    default: return styles.checkDotNeutral;
  }
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8.5l3.5 3.5L13.5 4.5"/>
    </svg>
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

function BranchHeading({ branch, upstream, ahead, behind, base, baseAhead, baseBehind, prResolved }: { branch: string; upstream: string | null; ahead: number; behind: number; base: string | null; baseAhead: number; baseBehind: number; prResolved?: boolean }) {
  const sameNameUpstream = upstream && /^[^/]+\/(.+)$/.exec(upstream)?.[1] === branch;
  const showBase = !prResolved && !!base;
  const sync = branchSync(upstream, ahead, behind);
  return (
    <div className={styles.branchHeading}>
      <BranchIcon className={styles.branchHeadingIcon}/>
      <span className={styles.rowKind}>Branch</span>
      <span
        className={`${styles.branchSyncPill} ${sync.cls}`}
        title={sync.title}
      >
        {sync.label}
      </span>
      <span className={styles.branchNameBig}>{branch}</span>
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
        {showBase && (baseAhead > 0 || baseBehind > 0) && (
          <span className={styles.abGroup} title={`Relative to ${base}`}>
            <span className={styles.abLabel}>vs {base}</span>
            {baseAhead > 0 && <span className={styles.aheadBadge}>↑{baseAhead}</span>}
            {baseBehind > 0 && <span className={styles.behindBadge}>↓{baseBehind}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

function branchSync(upstream: string | null, ahead: number, behind: number): { label: string; cls: string; title: string } {
  if (!upstream) return { label: 'No remote', cls: styles.branchSyncNoRemote, title: 'No upstream branch — changes have never been pushed' };
  if (ahead > 0 && behind > 0) return { label: 'Diverged', cls: styles.branchSyncDiverged, title: `${ahead} ahead / ${behind} behind upstream` };
  if (ahead > 0) return { label: 'Ahead', cls: styles.branchSyncAhead, title: `${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream` };
  if (behind > 0) return { label: 'Behind', cls: styles.branchSyncBehind, title: `${behind} commit${behind === 1 ? '' : 's'} behind upstream` };
  return { label: 'Synced', cls: styles.branchSyncSynced, title: 'In sync with upstream' };
}

function CommitsSection({ commits }: { commits: GitStatus['branchCommits'] }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED = 4;
  const shown = expanded ? commits : commits.slice(0, COLLAPSED);
  const hidden = commits.length - shown.length;
  const unpushedCount = commits.filter(c => !c.pushed).length;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <CommitIcon className={styles.sectionIcon}/>
        <span className={styles.sectionLabel}>Commits</span>
        <span className={styles.sectionCount}>{commits.length}</span>
        {unpushedCount > 0 && (
          <span className={styles.sectionUnpushedBadge}>{unpushedCount} unpushed</span>
        )}
      </div>
      <ul className={styles.commitList}>
        {shown.map(c => (
          <li key={c.hash} className={styles.commitItem}>
            <span className={c.pushed ? styles.commitDotPushed : styles.commitDotUnpushed} title={c.pushed ? 'Pushed' : 'Unpushed'}/>
            <span className={styles.commitHash}>{c.hash}</span>
            <span className={styles.commitItemSubject}>{c.subject}</span>
            {c.filesChanged > 0 && <span className={styles.commitFiles}>{c.filesChanged} files</span>}
            <span className={styles.commitTime}>{c.relativeTime}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button className={styles.expandButton} onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      )}
      {expanded && commits.length > COLLAPSED && (
        <button className={styles.expandButton} onClick={() => setExpanded(false)}>
          Collapse
        </button>
      )}
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
