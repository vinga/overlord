## Spec: Worker Plan Pill

**Goal:** Surface the most recent ExitPlanMode plan on each worker card so users can see at a glance *what the session committed to doing* without opening the detail panel.

**Placement rationale:** Plans are per-session artifacts (one transcript → many plans over time). Branch info lives at the room level because every session in a room shares a `cwd`; plans do not share across sessions. The correct home is therefore the `Worker` card itself — right next to the session name / current-task label — not next to the room-level `GitBranchBadge`.

**Inputs / Triggers:**
- A session has at least one `kind: 'plan'` entry in `session.completionSummaries` (already broadcast today by `stateManager` via `taskStorage.createPlanTask`).
- User hovers or clicks the pill → popover opens with plan markdown.

**Outputs / Side effects:**
- New pill rendered inside `Worker` (or `WorkerGroup` main row) showing a plan icon + `planStatus` color dot.
- On open, a portal-mounted popover renders `planContent` as sanitized markdown (reuse `renderMarkdown` from `DetailPanel.tsx` or `renderPlanMarkdown` from `TaskListPanel.tsx`).
- No new server endpoint. No new WebSocket message. Purely client-side consumption of existing data.

---

### Data model (already present)

`Session.completionSummaries: Task[]` where a plan entry has:
```ts
{
  kind: 'plan',
  planContent: string,          // markdown
  planToolUseId: string,
  planStatus: 'approved' | 'rejected' | 'pending',
  createdAt: string,
  completedAt?: string,
  title: string,                // derived from first non-empty line
}
```

### Selection rule

For a given session, pick the latest plan:
1. Filter `completionSummaries` where `kind === 'plan'`.
2. Sort by `completedAt ?? createdAt` desc.
3. Take the first. Call it `latestPlan`.
4. If no `latestPlan`, render nothing (no pill).

Subagents do not get their own pill — plans are attached to the parent session.

### Client

**New component** `WorkerPlanPill` (new file `packages/client/src/components/WorkerPlanPill.tsx` + CSS module).

Props:
```ts
interface Props {
  plan: {
    title: string;
    planContent: string;
    planStatus: 'approved' | 'rejected' | 'pending';
    completedAt?: string;
    createdAt: string;
  };
}
```

**Pill visual**
- Compact horizontal chip: plan icon (📋 or inline SVG checklist), status dot (green approved / red rejected / grey pending), plan title truncated to ~28 chars.
- Status dot colors match existing `TaskListPanel` palette: `#22c55e` / `#ef4444` / `#6b7280`.
- Tooltip on hover via native `title=` with full title + relative age.
- Cursor pointer; subtle border matching Worker card idioms.

**Popover behaviour** (mirror `GitBranchBadge`)
- Hover opens; click pins; `Escape` or outside click closes.
- Portal-mounted to `document.body` with auto-flip placement (bottom preferred, flip to top if no room).
- Body:
  - Header row: status pill (`Approved` / `Rejected` / `Pending`) · plan title · relative time (e.g. `2m ago`).
  - Scrollable markdown body (max height ~420px) rendered from `planContent`. Reuse existing `.planContent` CSS class from `DetailPanel.module.css` for consistent typography.
  - Footer link: "Open in detail panel" — clicking selects the session and opens the Tasks tab scrolled to this plan (best-effort; if deep-linking is complex, v1 just opens the panel).

**Integration point**
- `WorkerGroup.tsx` is the right host because it already owns the session-level layout and has room below `Worker` for auxiliary info (subagents stack there). Render the pill as a small chip **inside `Worker` under the name row** if space allows, otherwise as a new sibling row between `Worker` and the subagents list.
- Decision: render inside `Worker` next to `currentTaskLabel`. If both are present, the plan pill appears to the right of the current-task label, truncating first.

**Empty state**
- No pill rendered. No placeholder dot. Worker card looks exactly as it does today when there's no plan.

**Rejected / pending plans**
- Still shown — users want to see that a plan was proposed and rejected. The status dot disambiguates.

**Stale plans**
- Any plan in `completionSummaries` qualifies regardless of age. Users can manually dismiss via a future enhancement (out of scope).

---

### Acceptance Criteria

**Data**
- [ ] When `session.completionSummaries` contains no `kind: 'plan'` entry, the worker card renders identically to the current baseline.
- [ ] When one or more plan entries exist, `WorkerPlanPill` renders with the latest one by `completedAt ?? createdAt`.
- [ ] Subagent rows do NOT get a plan pill.

**Visual**
- [ ] Pill shows plan icon, status-colored dot, and truncated title (28 chars, ellipsis).
- [ ] Status colors match the existing `TaskListPanel` palette (`#22c55e` / `#ef4444` / `#6b7280`).
- [ ] Pill does not visually dominate the worker card — same weight as a small metadata chip.

**Interaction**
- [ ] Hover opens the popover; mouse-leave closes it (unless pinned).
- [ ] Click toggles pinned state; pinned popover persists until outside click or `Escape`.
- [ ] Popover auto-flips to top placement when there isn't enough space below.
- [ ] Popover markdown body is scrollable when content exceeds ~420px.

**Markdown rendering**
- [ ] `planContent` renders using the existing `.planContent` CSS class.
- [ ] Rendering uses the same sanitized renderer as `TaskListPanel` / `DetailPanel` (no new renderer introduced).
- [ ] Dangerous HTML is sanitized (inherit existing renderer's behavior).

**Regression**
- [ ] No console errors when toggling the pill.
- [ ] No layout shift in rooms with many workers (pill does not cause wrapping that pushes other workers).
- [ ] `DetailPanel` Tasks tab still renders plans exactly as it does today.

---

### Out of scope

- **Room-level plan aggregation** (one pill per room showing "3 plans across 2 sessions"). Per-worker is the agreed scope.
- **Deep-link** from popover "Open in detail panel" to the specific plan row in Tasks tab — v1 just opens the panel.
- **Dismiss / archive** action on plans from the pill.
- **Live plan-pending indicator** (showing a plan is currently being proposed before ExitPlanMode resolves).
- **Plan diff** (what changed between successive plans in the same session).
- **Backend changes** — the data is already broadcast. Zero server edits.

### Open questions

1. **Icon choice.** Use an inline SVG (matching `GitBranchBadge` icon style) or an emoji 📋? SVG is more consistent; emoji is faster to ship. Proposed: SVG checklist.
2. **Rejected plans — always show, or only if they are the latest?** Current spec says always show the latest regardless of status. Alternative: hide rejected unless explicitly toggled. Proposed: always show latest (transparency).
3. **Title truncation length.** 28 chars was a guess. May need tuning once rendered. Confirm after first screenshot.
4. **Popover width.** `GitBranchBadge` tooltip is wide (~420px). Plan markdown often needs more room. Proposed: 480px max-width, `max-height: min(60vh, 480px)`.
