# Plan: Lazy PR actions + async tooltip rendering

## Server

- [ ] Extend `prCache` to fetch checks alongside PR metadata (`gh pr checks`), storing in same entry. Add `checks` + `mergeable` fields to `CacheEntry`.
- [ ] Add `getChecks(cwd, branch)` sync read + `getOrFetchPr(cwd, branch)` async — returns `{ pullRequest, checks, mergeable, error }`.
- [ ] Add `GET /api/git/pr?cwd=...&branch=...` in `apiRoutes.ts`. Awaits `getOrFetchPr`.
- [ ] Remove `pullRequest` from `/api/git/status` response (keep field in type as `null` for back-compat, but don't fetch).
- [ ] Verify `/api/git/status` no longer blocks on `gh`.

## Client

- [ ] `GitBranchBadge`: add second state `prData` + `prLoading` + `prError`. Fire parallel fetch on open.
- [ ] Rename old `status.pullRequest` uses — take from `prData` instead.
- [ ] New `ChecksSection` component with summary pill + collapsible list.
- [ ] Render PR row / checks from `prData`; show shimmer while loading; show error note on failure.
- [ ] Update types (`GitStatus.pullRequest` gone; new `PrData` type).

## Verification

- [ ] Walk acceptance criteria 1-by-1.
- [ ] Browser: open tooltip on a room with a PR → header + files + commits appear <500ms, PR/checks shimmer then populate.
- [ ] Open tooltip on a room with no PR → no shimmer stays forever; PR section cleanly empty.
- [ ] Kill `gh` command (simulate error) → PR section shows error, rest renders fine.
