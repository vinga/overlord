## Spec: Effort level in Brain tab

**Goal:** Surface the Claude Code `effortLevel` setting (global + per-project override) as a card in the Brain tab, so users can see the active reasoning effort without leaving Overlord.

**Placement:** New `Effort` card in `packages/client/src/components/BrainTab.tsx`, rendered alongside the existing Identity / Memory / Hooks / Skills / Agents / MCP / Permissions cards.

---

### Inputs / Triggers

- User opens the Brain tab for a room (existing `GET /api/brain?cwd=…` request).
- `~/.claude/settings.json` or `<cwd>/.claude/settings.json` or `<cwd>/.claude/settings.local.json` mtime changes (already invalidates the brain cache via existing source-tracking).
- Manual refresh of Brain tab.

### Outputs / Side effects

- `GET /api/brain` response gains an `effort` field.
- Brain tab renders an `Effort` card listing Global + Project values with the effective level highlighted.
- No persistence, no writes, no WebSocket traffic.

---

### Server

**File: `packages/server/src/brain/brainContext.ts`**

- New type:
  ```ts
  export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | string | null;
  export interface BrainEffort {
    global: { value: EffortValue; source: string | null };
    project: { value: EffortValue; source: string | null }; // null source = no override
    effective: EffortValue;
  }
  ```
- Extend `BrainContext`:
  ```ts
  effort: BrainEffort;
  ```
- New extractor `extractEffort(settings: SettingsWithSource[], home: string, cwd: string): BrainEffort`:
  1. Walk `settings` (already collected by `collectSettings`).
  2. For each entry, read `data.effortLevel` if it is a string.
  3. Classify by `source`:
     - matches `<home>/.claude/settings.json` → global
     - matches `<cwd>/.claude/settings.json` or `<cwd>/.claude/settings.local.json` → project (local overrides non-local)
  4. `effective = project.value ?? global.value ?? null`.
- Call `extractEffort` inside `getBrainContext` and include it in the returned object.
- No changes needed to cache invalidation — `settings.json` paths are already in the source list.

**File: `packages/server/src/api/apiRoutes.ts`** — no change (response is already `brainContext` verbatim).

### Client

**File: `packages/client/src/components/BrainTab.tsx`**

- Mirror server types:
  ```ts
  interface BrainEffort {
    global: { value: string | null; source: string | null };
    project: { value: string | null; source: string | null };
    effective: string | null;
  }
  ```
- Add `effort: BrainEffort` to the local `BrainContext` interface.
- Extend `CardKey` with `'effort'`; add `effort: true` to `DEFAULT_OPEN` (show by default — it's small and informational).
- Render an `Effort` card between Identity and Memory with two rows:
  - `Global` — value pill (e.g. `xhigh`) or `—` when unset, source path in muted text.
  - `Project` — value pill or `—`, source path in muted text.
  - Effective value shown above the rows as a prominent chip (same size/style as the existing permission-mode chip in `DetailPanel`).
- Layout: reuse existing card styles from `BrainTab.module.css`; no new module needed unless a pill style is missing — in that case add `.effortChip` / `.effortRow` to `BrainTab.module.css`.
- When `effort.effective === null`, show the card with value `—` and a muted caption: "No effort level configured".

**File: `packages/client/src/components/BrainTab.module.css`** — add minimal styles for the chip + row (muted source path, small value pill) only if existing classes don't cover it.

### UX rules

- Value pill uses the same accent as permission-mode for consistency.
- When `project` has a value, the Global row is dimmed to signal it's overridden.
- Clicking the source path is **not** a link (matches existing cards' behavior).

---

### Acceptance Criteria

**Server**
- [ ] `GET /api/brain?cwd=…` response includes `effort: { global, project, effective }`.
- [ ] With only `~/.claude/settings.json` setting `effortLevel: "xhigh"`, response returns `global.value === "xhigh"`, `project.value === null`, `effective === "xhigh"`.
- [ ] With a project `.claude/settings.json` setting `effortLevel: "medium"` in addition, response returns `project.value === "medium"`, `effective === "medium"`.
- [ ] `project.source` equals the local override path when present, else `null`.
- [ ] Touching `~/.claude/settings.json` invalidates the brain cache within existing TTL behavior (no new watcher needed).
- [ ] No change to `permissions`, `hooks`, `skills`, `agents`, `mcpServers` outputs.

**Client**
- [ ] Brain tab renders an `Effort` card with `Global` and `Project` rows.
- [ ] Effective value chip is visible above the two rows and matches `brain.effort.effective`.
- [ ] When project override is absent, Project row shows `—` in muted style.
- [ ] When project override is present, Global row is visually dimmed.
- [ ] Card open/closed state persists in `localStorage` under the existing `brainTab:<cwd>:cards` key.
- [ ] No console errors; layout is stable on a narrow (<400px) DetailPanel width.

**Performance**
- [ ] Adds <2ms to `getBrainContext` cold path (single field read from already-parsed JSON).
- [ ] No new disk reads beyond the existing `collectSettings` call.

---

### Out of scope

- Writing / changing `effortLevel` from Overlord (read-only).
- Surfacing effort on the Worker card, Room badge, or DetailPanel header.
- Per-session effort overrides (Claude Code does not support them; `/effort` writes the global file).
- Watching settings.json with chokidar for live push — the brain tab already refetches on open and the cache TTL covers flips during a session.

### Open questions

1. Should the chip sit next to the permission-mode pill in `DetailPanel` instead of (or in addition to) the Brain tab? Suggest: **Brain tab only for v1** — keeps DetailPanel header uncluttered and matches how other settings-derived info is surfaced. Revisit once the Brain card lands and we see whether users want it at-a-glance.
2. Render raw `effortLevel` strings (`xhigh`, `low`) verbatim, or map to display labels (`Extra High`, `Low`)? Suggest: **verbatim** — matches how `/effort` names them and avoids drift if Claude Code adds new levels.
3. Should `settings.local.json` be treated as a third tier or folded into project? Suggest: **folded into project**, with `local` winning over the non-local project file (mirrors how `collectSettings` already orders them).
