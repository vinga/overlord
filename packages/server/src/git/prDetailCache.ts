import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prRefKey, splitPrRef } from './prRef.js';
import type { PrBlocker, PrCheck, PrDetail, PrReview } from '../types.js';

// Details for the PR hover card: description, checks, reviews and what an open
// PR is waiting on. Fetched only on demand (a hover, or a PR card on screen),
// never from the snapshot loop. REST only — gh's `core` pool, not GraphQL.

const execFileAsync = promisify(execFile);

const OPEN_TTL_MS = 60 * 1000;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY = 20_000;

export type PrDetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; reason: 'bad-ref' | 'not-found' | 'error' };

const cache = new Map<string, { result: PrDetailResult; at: number }>();
const inflight = new Map<string, Promise<PrDetailResult>>();

export function clearPrDetailCache(): void { cache.clear(); }

interface RestUser { login?: string }
export interface RestPull {
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: RestUser | null;
  closed_at?: string | null;
  updated_at?: string;
  mergeable_state?: string;
  user?: RestUser;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
  requested_reviewers?: RestUser[];
  requested_teams?: { name?: string; slug?: string }[];
}
export interface RestReview { user?: RestUser; state?: string; submitted_at?: string }
export interface RestCheckRun { name?: string; status?: string; conclusion?: string | null; html_url?: string; details_url?: string; completed_at?: string | null; started_at?: string | null }
export interface RestStatus { context?: string; state?: string; target_url?: string | null; updated_at?: string }

/** Latest meaningful review per user (COMMENTED never overrides a decision). */
export function latestReviews(reviews: RestReview[]): PrReview[] {
  const byUser = new Map<string, PrReview>();
  for (const r of reviews) {
    const user = r.user?.login;
    const state = (r.state ?? '').toUpperCase();
    if (!user || !state || state === 'PENDING') continue;
    const prev = byUser.get(user);
    if (state === 'COMMENTED' && prev && prev.state !== 'COMMENTED') continue;
    // DISMISSED clears an earlier decision.
    byUser.set(user, { user, state: state as PrReview['state'], at: r.submitted_at });
  }
  return [...byUser.values()].filter(r => r.state !== 'DISMISSED');
}

/** Check runs + old-style statuses → one list; a re-run replaces the older run of the same name. */
export function mergeChecks(runs: RestCheckRun[], statuses: RestStatus[]): PrCheck[] {
  const byName = new Map<string, PrCheck & { t: string }>();
  const put = (c: PrCheck & { t: string }) => {
    const prev = byName.get(c.name);
    if (!prev || c.t >= prev.t) byName.set(c.name, c);
  };
  for (const r of runs) {
    if (!r.name) continue;
    const status = (r.status ?? '').toLowerCase();
    const concl = (r.conclusion ?? '').toLowerCase();
    let state: PrCheck['state'];
    if (status !== 'completed') state = 'running';
    else if (['success', 'neutral', 'skipped'].includes(concl)) state = concl === 'success' ? 'passed' : 'skipped';
    else state = 'failed';
    put({ name: r.name, state, url: r.html_url ?? r.details_url, t: r.completed_at ?? r.started_at ?? '' });
  }
  // Statuses come newest first; keep the first per context.
  const seen = new Set<string>();
  for (const s of statuses) {
    if (!s.context || seen.has(s.context)) continue;
    seen.add(s.context);
    const st = (s.state ?? '').toLowerCase();
    const state: PrCheck['state'] = st === 'success' ? 'passed' : st === 'pending' ? 'running' : 'failed';
    put({ name: s.context, state, url: s.target_url ?? undefined, t: s.updated_at ?? '' });
  }
  return [...byName.values()].map(({ t: _t, ...c }) => c);
}

const names = (xs: string[], max = 3) =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} +${xs.length - max}`;

/** What an open PR is waiting on, most blocking first. Empty for merged / closed. */
export function computeWaitingOn(pr: RestPull, reviews: PrReview[], checks: PrCheck[]): PrBlocker[] {
  if ((pr.state ?? '').toLowerCase() !== 'open') return [];
  const out: PrBlocker[] = [];
  const base = pr.base?.ref ?? 'base';
  const ms = (pr.mergeable_state ?? '').toLowerCase();
  if (pr.draft) out.push({ kind: 'draft', tone: 'muted', text: 'Draft — not ready for review' });
  if (ms === 'dirty') out.push({ kind: 'conflicts', tone: 'bad', text: `Merge conflicts with ${base}` });
  const failed = checks.filter(c => c.state === 'failed').map(c => c.name);
  const running = checks.filter(c => c.state === 'running').map(c => c.name);
  if (failed.length) out.push({ kind: 'checks-failed', tone: 'bad', text: `${failed.length} check${failed.length > 1 ? 's' : ''} failing: ${names(failed)}` });
  if (running.length) out.push({ kind: 'checks-running', tone: 'warn', text: `${running.length} check${running.length > 1 ? 's' : ''} running: ${names(running)}` });
  const changes = reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.user);
  if (changes.length) out.push({ kind: 'changes-requested', tone: 'bad', text: `Changes requested by ${names(changes)}` });
  const reviewed = new Set(reviews.map(r => r.user));
  const pending = [
    ...(pr.requested_reviewers ?? []).map(u => u.login).filter((l): l is string => !!l && !reviewed.has(l)),
    ...(pr.requested_teams ?? []).map(t => t.name ?? t.slug).filter((n): n is string => !!n),
  ];
  if (pending.length) out.push({ kind: 'review', tone: 'warn', text: `Review from ${names(pending)}` });
  else if (!pr.draft && !reviews.some(r => r.state === 'APPROVED') && !changes.length && ms === 'blocked') {
    out.push({ kind: 'review', tone: 'warn', text: 'Waiting for an approving review' });
  }
  if (ms === 'behind') out.push({ kind: 'behind', tone: 'warn', text: `Branch behind ${base}` });
  if (ms === 'unknown' || (!ms && !out.length)) out.push({ kind: 'unknown', tone: 'muted', text: 'Checking mergeability…' });
  if (ms === 'blocked' && !out.length) out.push({ kind: 'blocked', tone: 'warn', text: 'Blocked by branch protection' });
  if (!out.length) out.push({ kind: 'ready', tone: 'good', text: 'Ready to merge' });
  return out;
}

export function buildDetail(ref: string, pr: RestPull, reviews: RestReview[], runs: RestCheckRun[], statuses: RestStatus[]): PrDetail {
  let state = (pr.state ?? '').toUpperCase();
  if (state === 'CLOSED' && (pr.merged || pr.merged_at)) state = 'MERGED';
  const latest = latestReviews(reviews);
  const checks = mergeChecks(runs, statuses);
  const body = pr.body ?? '';
  return {
    ref,
    url: pr.html_url,
    title: pr.title,
    state: state || undefined,
    isDraft: !!pr.draft,
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body,
    author: pr.user?.login,
    headRef: pr.head?.ref,
    baseRef: pr.base?.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    comments: (pr.comments ?? 0) + (pr.review_comments ?? 0),
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at ?? undefined,
    mergedBy: pr.merged_by?.login,
    closedAt: pr.closed_at ?? undefined,
    reviews: latest,
    requestedReviewers: (pr.requested_reviewers ?? []).map(u => u.login).filter((l): l is string => !!l),
    checks,
    waitingOn: computeWaitingOn(pr, latest, checks),
  };
}

async function gh<T>(path: string): Promise<T> {
  const { stdout } = await execFileAsync('gh', ['api', '-X', 'GET', '-H', 'Accept: application/vnd.github+json', path], {
    timeout: FETCH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function fetchDetail(ref: string): Promise<PrDetailResult> {
  const parts = splitPrRef(ref);
  if (!parts) return { ok: false, reason: 'bad-ref' };
  const repo = `/repos/${parts.owner}/${parts.repo}`;
  let pr: RestPull;
  try {
    pr = await gh<RestPull>(`${repo}/pulls/${parts.number}`);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    return { ok: false, reason: /404|Not Found/i.test(msg) ? 'not-found' : 'error' };
  }
  const open = (pr.state ?? '').toLowerCase() === 'open';
  const sha = pr.head?.sha;
  const [reviews, runs, statuses] = await Promise.all([
    open ? gh<RestReview[]>(`${repo}/pulls/${parts.number}/reviews?per_page=100`).catch(() => []) : Promise.resolve([]),
    open && sha ? gh<{ check_runs?: RestCheckRun[] }>(`${repo}/commits/${sha}/check-runs?per_page=100`).then(r => r.check_runs ?? []).catch(() => []) : Promise.resolve([]),
    open && sha ? gh<RestStatus[]>(`${repo}/commits/${sha}/statuses?per_page=100`).catch(() => []) : Promise.resolve([]),
  ]);
  return { ok: true, detail: buildDetail(`${parts.owner}/${parts.repo}#${parts.number}`, pr, reviews, runs, statuses) };
}

function ttl(r: PrDetailResult): number {
  if (!r.ok) return MISS_TTL_MS;
  return r.detail.state === 'OPEN' ? OPEN_TTL_MS : TERMINAL_TTL_MS;
}

export function getPrDetail(ref: string, now = Date.now()): Promise<PrDetailResult> {
  if (!splitPrRef(ref)) return Promise.resolve({ ok: false, reason: 'bad-ref' });
  const key = prRefKey(ref);
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl(hit.result)) return Promise.resolve(hit.result);
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchDetail(ref)
    .then((result) => { cache.set(key, { result, at: Date.now() }); return result; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
