## Spec: Change Summary prompt command

**Goal:** Add a "Change Summary" quick-prompt to the conversation burger menu that asks Claude to produce a structured, high-level recap of programmatic changes on the current branch, plus refactor all burger-menu presets into a dedicated module.

**Placement:** Burger menu inside `DetailPanel` (conversation view), alongside existing quick-prompt items.

---

### Inputs / Triggers

- User clicks **Change Summary** in the conversation burger menu.

### Outputs / Side effects

- Injects a preset prompt string into the active session via the existing `sendText` path. No server state mutation.

---

### Server

_N/A_ — reuses existing inject path.

### Client

**New file:** `packages/client/src/components/quickPrompts.ts`

```ts
export interface QuickPrompt {
  id: string;
  label: string;
  body: string; // the text injected into the session
}

export const QUICK_PROMPTS: QuickPrompt[] = [
  { id: 'remind',          label: 'Remind me where we left off', body: '...' },
  { id: 'cut-fluff',       label: 'Cut the fluff',                body: '...' },
  { id: 'pr-review',       label: 'Handle PR Review Comments',    body: '...' },
  { id: 'change-summary',  label: 'Change Summary',               body: CHANGE_SUMMARY },
];
```

**Refactor:** `packages/client/src/components/DetailPanel.tsx` — replace the three inline `<button>` blocks inside `styles.quickMenu` with `QUICK_PROMPTS.map(p => <button …>{p.label}</button>)`. Each button keeps the current `onMouseDown` semantics (preventDefault, close menu, `sendText(p.body)`).

**Change Summary prompt body** (scope = whole branch vs. `main`, ASCII diagram, no coverage):

```
Produce a "Change Summary" for the work done on this branch vs. main.

Run, in parallel where independent:
- git rev-parse --abbrev-ref HEAD
- git rev-list --left-right --count main...HEAD
- git diff --stat main...HEAD
- git diff --numstat main...HEAD
- git log main..HEAD --oneline
- git status --porcelain
- the project's test / lint / typecheck commands (infer from package.json / pyproject / etc.)

Emit exactly this markdown:

## Change Summary — <branch>

### Verification
- Tests:  <passed>/<total>, <skipped> skipped
- Lint:   <clean | N issues>
- Types:  <clean | N issues>
- Build:  <✅ | ❌ | skipped>
- Branch: <branch>
- Base:   main (<N> ahead, <M> behind)
- Dirty:  <N uncommitted files | clean>

### Stats
- Files:   +<N> created / ~<N> modified / -<N> deleted
- LOC:     +<N> / -<N>
- Tests:   +<N> added / ~<N> modified
- Commits: <N>

### Touched Areas
<ASCII diagram of top-level modules touched; show dependencies with arrows>

### By Subsystem
- **<path>**: <one-line what changed>
- ...

### Tests
- Added:    <file> (<N> cases)
- Modified: <file>

### Public Surface Changes
- New/changed API endpoints, WS message types, exports, config keys, env vars.
- Write "none" if none.

### Risk / Boundaries Crossed
- DB migrations, schema, protocol, auth, perf-hot paths. "none" if none.

### Out of Scope / Not Changed
- Bullets of things intentionally skipped.

### Commits
- <sha> <subject>
- ...

Rules:
- Each bullet ≤ 1 line.
- Omit optional sections when empty; keep Verification + Stats + Touched Areas + Commits always.
- Do NOT paste raw diff hunks.
- Use ASCII only in the diagram.
```

---

### Acceptance Criteria

**Client**
- [ ] New file `packages/client/src/components/quickPrompts.ts` exists and exports `QUICK_PROMPTS: QuickPrompt[]`.
- [ ] `QUICK_PROMPTS` contains four entries with ids `remind`, `cut-fluff`, `pr-review`, `change-summary` in that order.
- [ ] `DetailPanel.tsx` renders the burger-menu items from `QUICK_PROMPTS.map(...)`; no inline preset body strings remain in `DetailPanel.tsx`.
- [ ] Clicking each item still calls `sendText(prompt.body)` and closes the menu.
- [ ] "Change Summary" label visible as the 4th item in the menu.
- [ ] Menu styling unchanged (same `quickMenuItem` class).

**Output shape (when Claude runs the preset)**
- [ ] Output contains the headings: `Verification`, `Stats`, `Touched Areas`, `Commits` (mandatory).
- [ ] Verification lists: Tests, Lint, Types, Build, Branch, Base, Dirty.
- [ ] Stats lists: Files, LOC, Tests, Commits.
- [ ] Diagram block is ASCII only.
- [ ] No raw diff hunks.

---

### Out of scope

- Auto-running the summary (no hook, no scheduler).
- Persisting summaries to disk.
- Coverage delta.
- Mermaid / non-ASCII diagrams.
- Modifier UI for scope (always whole-branch vs. main).

### Open questions

_None — decisions locked in during review: separate presets file, ASCII diagram, whole-branch scope, no coverage._
