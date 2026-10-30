/**
 * Branches a session pushed, canonicalised as `owner/repo:branch`.
 *
 * Pure — parsed from `git push` output in tool results, so the repo comes from
 * the remote the push went to, never from the session's cwd: a session in one
 * checkout routinely pushes to several repos.
 */

const NAME = String.raw`[A-Za-z0-9._-]+`;
/** `git@host:o/r.git`, `ssh://git@host[:port]/o/r.git`, `https://host/o/r(.git)`. */
const REMOTE_REGEX = new RegExp(
  String.raw`^(?:(?:[^@\s/]+@)?[^:\s/]+:|(?:ssh|https?|git)://(?:[^@\s/]+@)?[^/\s]+/)(${NAME})/(${NAME}?)(?:\.git)?/?$`,
);
/** Ref-update lines: ` * [new branch]   x -> x`, `   a1b2..c3d4  x -> x`, `+ a...b x -> x (forced update)`. */
const UPDATE_LINE = /^\s*[*+ ]?\s*(\[new branch\]|[0-9a-f]{4,}\.\.\.?[0-9a-f]{4,})\s+\S+\s+->\s+(\S+)/;

/** Remote URL → `owner/repo`. Null for local paths and unknown shapes. */
export function parseRemoteUrl(url: string): string | null {
  const m = REMOTE_REGEX.exec(url.trim());
  if (!m || !m[2]) return null;
  const repo = m[2].replace(/\.git$/, '');
  return repo ? `${m[1]}/${repo}` : null;
}

/** `owner/repo:branch` refs for every branch update in a `git push` output.
 *  Rejected, deleted and tag updates are skipped; so is anything after a
 *  `To` line whose remote isn't a recognisable repo URL. */
export function parseGitPushOutput(text: string): string[] {
  const out: string[] = [];
  let repo: string | null = null;
  for (const line of text.split('\n')) {
    const to = /^To\s+(\S+)\s*$/.exec(line);
    if (to) { repo = parseRemoteUrl(to[1]); continue; }
    if (!repo) continue;
    const m = UPDATE_LINE.exec(line);
    if (!m) continue;
    const branch = m[2].replace(/^refs\/heads\//, '');
    if (branch.startsWith('refs/')) continue;
    out.push(`${repo}:${branch}`);
  }
  return out;
}

/** `owner/repo:branch` → parts. Null when malformed. */
export function splitBranchRef(ref: string): { repo: string; branch: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { repo: ref.slice(0, i), branch: ref.slice(i + 1) };
}

/** Dedupe key: repo is case-insensitive, the branch name is not. */
export function branchRefKey(ref: string): string {
  const parts = splitBranchRef(ref);
  return parts ? `${parts.repo.toLowerCase()}:${parts.branch}` : ref;
}
