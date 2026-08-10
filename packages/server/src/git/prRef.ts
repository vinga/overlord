/**
 * Pull-request references, canonicalised as `owner/repo#number`.
 *
 * Pure — no I/O, no config. Deliberately host-agnostic: GitHub Enterprise lives
 * on private hostnames, so the shape of the path (`/owner/repo/pull/<digits>`)
 * is what identifies a PR, not the domain. Same lesson as the JIRA `/browse/`
 * widening.
 */

/** Owner and repo names: alphanumerics plus `-`, `_`, `.`. */
const NAME = String.raw`[A-Za-z0-9._-]+`;
const PR_URL_REGEX = new RegExp(
  String.raw`^https?://[^/\s]+/(${NAME})/(${NAME})/pull/(\d+)(?:[/?#]|$)`,
);
const PR_REF_REGEX = new RegExp(String.raw`^(${NAME})/(${NAME})#(\d+)$`);

/** Punctuation that trails a URL in prose but isn't part of it. */
const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;

export interface PrRefParts {
  owner: string;
  repo: string;
  number: number;
}

/** `https://host/o/r/pull/819/files` → `o/r#819`. Null when not a PR URL. */
export function parsePrUrl(url: string): string | null {
  const trimmed = url.trim().replace(TRAILING_PUNCT, '');
  const m = PR_URL_REGEX.exec(trimmed);
  if (!m) return null;
  const number = Number(m[3]);
  // `/pull/0` and overflowing digit runs aren't real PRs.
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `${m[1]}/${m[2]}#${number}`;
}

/** `o/r#819` → parts. Null when malformed — the validation gate for anything
 *  arriving from the client before it reaches a persisted record. */
export function splitPrRef(ref: string): PrRefParts | null {
  const m = PR_REF_REGEX.exec(ref.trim());
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: m[1], repo: m[2], number };
}

/** Dedupe key. GitHub owner/repo are case-insensitive; we store as written. */
export function prRefKey(ref: string): string {
  return ref.toLowerCase();
}

/** Fallback URL for a ref whose originating host we no longer have. Refs
 *  detected from a URL carry their real host through `PrRefMeta.url`; this is
 *  only used when metadata never resolved. */
export function prRefUrl(ref: string): string {
  const parts = splitPrRef(ref);
  if (!parts) return '';
  return `https://github.com/${parts.owner}/${parts.repo}/pull/${parts.number}`;
}

/** Short display label: `#819`. */
export function prRefLabel(ref: string): string {
  const parts = splitPrRef(ref);
  return parts ? `#${parts.number}` : ref;
}
