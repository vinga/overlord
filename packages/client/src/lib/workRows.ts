import type { PrRefMeta } from '../types';

/** One piece of a session's own work: a PR, a pushed branch, or both. */
export interface WorkRow {
  /** `owner/repo`, as written. */
  repo: string;
  /** `owner/repo#N` when there is a PR. */
  ref?: string;
  number?: number;
  branch?: string;
  meta?: PrRefMeta;
}

export interface WorkRows {
  /** PRs this session opened or pushed to, and branches it pushed — grouped by
   *  repo (first appearance order), newest work last inside a repo. */
  own: WorkRow[];
  /** PRs the session only mentioned. */
  mentioned: WorkRow[];
}

function splitPr(ref: string): { repo: string; number?: number } {
  const i = ref.lastIndexOf('#');
  if (i < 0) return { repo: ref };
  const n = Number(ref.slice(i + 1));
  return { repo: ref.slice(0, i), number: Number.isSafeInteger(n) ? n : undefined };
}

function splitBranch(ref: string): { repo: string; branch: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { repo: ref.slice(0, i), branch: ref.slice(i + 1) };
}

const lc = (s: string) => s.toLowerCase();

/**
 * Fold a session's PR refs and pushed branches into rows.
 *
 * A PR is the session's own when it printed it from `gh pr create`
 * (`authored`), or when it pushed the PR's head branch. A pushed branch with
 * a PR folds into that PR's row; one without stays a bare branch row.
 */
export function buildWorkRows(
  prRefs: string[] | undefined,
  authored: string[] | undefined,
  branches: string[] | undefined,
  meta: Record<string, PrRefMeta> | undefined,
): WorkRows {
  const prRow = (ref: string): WorkRow => {
    const { repo, number } = splitPr(ref);
    const m = meta?.[ref];
    return { repo, ref, number, branch: m?.headRef, meta: m };
  };
  const allPrs = [...(authored ?? []), ...(prRefs ?? [])];
  const authoredKeys = new Set((authored ?? []).map(lc));
  const ownKeys = new Set<string>();
  const ordered: WorkRow[] = [];

  for (const ref of authored ?? []) {
    if (ownKeys.has(lc(ref))) continue;
    ownKeys.add(lc(ref));
    ordered.push(prRow(ref));
  }
  for (const b of branches ?? []) {
    const parts = splitBranch(b);
    if (!parts) continue;
    const already = ordered.find(r => r.branch === parts.branch && lc(r.repo) === lc(parts.repo));
    if (already) continue;
    // Pushing to a mentioned PR's head branch makes that PR this session's work.
    const pr = allPrs.find(r => !ownKeys.has(lc(r))
      && meta?.[r]?.headRef === parts.branch && lc(splitPr(r).repo) === lc(parts.repo));
    if (pr) {
      ownKeys.add(lc(pr));
      ordered.push(prRow(pr));
    } else {
      ordered.push({ repo: parts.repo, branch: parts.branch });
    }
  }

  // Group by repo, keeping each repo where it first appeared.
  const byRepo = new Map<string, WorkRow[]>();
  for (const row of ordered) {
    const key = lc(row.repo);
    const list = byRepo.get(key);
    if (list) list.push(row); else byRepo.set(key, [row]);
  }
  const own = [...byRepo.values()].flat();

  const mentioned: WorkRow[] = [];
  const seen = new Set<string>(ownKeys);
  for (const ref of prRefs ?? []) {
    if (seen.has(lc(ref)) || authoredKeys.has(lc(ref))) continue;
    seen.add(lc(ref));
    mentioned.push(prRow(ref));
  }
  return { own, mentioned };
}
