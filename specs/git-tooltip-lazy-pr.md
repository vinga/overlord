## Spec: Lazy PR actions + async tooltip rendering

**Goal:** Tooltip renders core git info immediately; PR metadata + checks stream in separately without blocking.

**Placement:** `GitBranchBadge` popup.

---

### Inputs / Triggers

- User opens tooltip (click branch badge).

### Outputs / Side effects

- Two parallel HTTP fetches per open. Each tooltip section renders independently as its data arrives.

---

### Server

**Split endpoints:**

- `GET /api/git/status?cwd=...` — local git only. Returns existing `GitStatus` shape **without** `pullRequest`. No `gh` calls on request path.
- `GET /api/git/pr?cwd=...&branch=...` — new. Returns `{ pullRequest: PrInfo | null, checks: Check[], mergeable: string | null, error: string | null }`.
  - `PrInfo` unchanged.
  - `Check = { name: string; state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPED' | 'CANCELLED' | 'NEUTRAL'; url?: string; elapsed?: string }`.
  - Implementation: extended `prCache` that also runs `gh pr checks <branch> --json name,state,bucket,link,startedAt,completedAt`.
  - Returns cached value immediately. If miss, triggers background refresh and awaits it (tooltip endpoint — OK to wait).
  - Cache TTLs: hit 30s, miss 60s.

### Client

- `GitBranchBadge`: on open, fires **two** parallel fetches:
  - `/api/git/status?cwd=...` → branch header, files, commits.
  - `/api/git/pr?cwd=...&branch=...` → PR row + `ChecksSection`.
- Each section independently shimmer → content. Fetch failure shows inline error, doesn't block the other.
- New `ChecksSection` (under PR row): inline pass/fail summary next to header; list of checks with colored dot, name, elapsed. Collapse to 5 + expand.

---

### Acceptance Criteria

**Server**
- [ ] `/api/git/status` responds <500ms p50 (no `gh` calls).
- [ ] `/api/git/pr?cwd=...&branch=...` returns `{ pullRequest, checks, mergeable, error }`.
- [ ] Checks cache: hit TTL 30s, miss TTL 60s.
- [ ] `gh pr checks` runs with 5s timeout; on error, returns `error` field populated, does not crash endpoint.

**Client**
- [ ] Branch header visible <500ms after open.
- [ ] PR/checks section independently shimmer → content, without blocking header/files/commits.
- [ ] `ChecksSection` shows summary `{pass}/{total} passing` (or red `{fail} failing`) in header.
- [ ] Failure of PR fetch shows a discreet error note in the PR section only.

---

### Out of scope

- Triggering/retrying actions from UI.
- Per-job logs.

### Open questions

_None — approved._
