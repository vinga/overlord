## Spec: Session tags

**Goal:** Let users assign any number of free-text tags to each session. Tags whose label matches a globally-configured entry render in that entry's color; unknown labels render neutral. Catalog is managed from a new global **Settings** view opened from the top burger menu.

**Placement:**
- Tag row rendered (1) under the name in the Worker card, (2) under the sessionName in the DetailPanel header.
- Global settings view opens from the `HeaderMenu` in `Office.tsx`, navigated to as a top-level view (same mechanism as **Logs**). Layout mimics `RoomDetailsTab.tsx` — plain panel with labeled sections and auto-save.

---

### Inputs / Triggers

- User opens the tag picker from the session header (`+ tag` affordance), checks existing catalog entries, and/or types a new label to add.
- User clicks a pill's × to remove it (undo toast).
- User opens **Settings** from the burger menu → **Tags** section → adds / renames / recolors / reorders / deletes catalog rows (auto-saved with 800 ms debounce).
- Server first boot: seed the catalog with `In review`, `Planning`, `Implementing`.
- Client mount: `GET /api/tags` once; refetch on `tags:changed` WS event.
- Page load: session tag assignments arrive with the existing `OfficeSnapshot`.

### Outputs / Side effects

- Catalog persisted to `~/.claude/overlord/tag-catalog.json`.
- Per-session assignments persisted to `~/.claude/overlord/overlord-sessions/{overlordId}.json` via `sessionStore.patch`.
- Catalog mutations broadcast a `tags:changed` WS frame.
- Session tag mutations broadcast via the existing `OfficeSnapshot`.
- Deleting a catalog entry only removes the color mapping — existing session assignments with that label keep rendering (in neutral color). No sweep.

---

### Server

**Types** added to `packages/server/src/types.ts`:

```ts
export interface TagEntry {
  label: string;   // free text, display-as-typed, 1–40 chars trimmed
  color: string;   // hex, 7-char (#rrggbb)
}
export interface TagCatalog {
  version: 1;
  entries: TagEntry[];  // order === rendered order
}
// Extend OverlordSession (packages/server/src/types.ts:175):
//   tags?: string[]   // free-text labels, display-as-typed
```

Mirror in `packages/client/src/types.ts`. Extend `Session` with `tags?: string[]`.

**Label matching:** case-insensitive, trimmed. Two entries with labels that match case-insensitively are not allowed in the catalog (reject on save). A session label like `"Planning"` matches a catalog entry `"planning"` for color lookup, but the session keeps its original casing on screen.

**New module** `packages/server/src/session/tagCatalog.ts`:

```ts
export function loadCatalog(): Promise<TagCatalog>;
export function saveCatalog(c: TagCatalog): Promise<TagCatalog>; // validates, persists, returns normalized
export function getColor(label: string): string | undefined;     // case-insensitive lookup
export function onCatalogChange(cb: (c: TagCatalog) => void): () => void;
```

Algorithm:
1. On first `loadCatalog()`, if the file is missing, write seed:
   - `{ label: "In review",    color: "#6366f1" }`
   - `{ label: "Planning",     color: "#f59e0b" }`
   - `{ label: "Implementing", color: "#10b981" }`
2. In-memory cache, `fs.watch` for external edits.
3. Atomic write (temp + rename).
4. `saveCatalog` validates:
   - Each label: trimmed, 1–40 chars; no two labels equal case-insensitively.
   - Each color: `/^#[0-9a-f]{6}$/i`.
5. Order in `entries[]` is the render order.

**New endpoints** in `packages/server/src/api/apiRoutes.ts`:

| Method | Path | Body / Params | Purpose |
|---|---|---|---|
| GET | `/api/tags` | — | return `TagCatalog` |
| PUT | `/api/tags` | `{ entries: TagEntry[] }` | replace catalog (auto-save from settings view) |
| PUT | `/api/sessions/:sessionId/tags` | `{ tags: string[] }` | assign free-text labels; server trims each, dedupes case-insensitively, rejects any label not 1–40 chars |

Errors:
- 400 invalid label (length, empty after trim) or color format
- 409 duplicate label in catalog (case-insensitive)
- 404 unknown sessionId on the session endpoint

After a catalog PUT, broadcast `{ type: "tags:changed", catalog }` on the WS. After a session tag PUT, trigger the normal `OfficeSnapshot` broadcast.

**Integration:**
- `stateManager.ts` folds `tags` from `OverlordSession` into the live `Session` object (same pattern as `intent`, `notes`).
- `wsHandler.ts` emits `tags:changed` via `onCatalogChange` registered in `index.ts`.
- No delete-sweep across sessions: removing a catalog entry leaves session labels intact.

### Client

**New hook** `packages/client/src/hooks/useTags.ts`:

```ts
interface UseTags {
  catalog: TagCatalog | null;
  loading: boolean;
  refresh(): Promise<void>;
  saveCatalog(entries: TagEntry[]): Promise<void>;            // PUT /api/tags (debounced by caller)
  assignToSession(sessionId: string, tags: string[]): Promise<void>;
  colorFor(label: string): string | undefined;                 // case-insensitive lookup
}
```

Subscribes to WS `tags:changed` for live refresh. Exposes `colorFor` used by the pill renderer.

**New components:**

- `components/TagPill.tsx`
  - Props: `{ label: string; color?: string; size?: "sm" | "md"; onRemove?: () => void }`
  - Rounded chip. If `color` given: background = `color` @ 18% α, text = `color` (darkened 25% when luminance > 0.65), border = `color` @ 35% α. If `color` undefined: neutral `#64748b` with same alpha rules.
  - `sm`: 16px / 10px font / 0 6px padding. `md`: 20px / 11px / 0 8px.
  - × on hover when `onRemove` present.

- `components/TagPicker.tsx`
  - Popover anchored to the `+ tag` button in the DetailPanel header.
  - Top: free-text input; Enter adds the typed label to the session (even if not in the catalog).
  - Below: catalog entries sorted by catalog order, each a checkbox pre-checked from the session's current tags (case-insensitive match).
  - Toggling a catalog entry adds/removes the canonical-cased label from the session.
  - Also lists any session-assigned labels that are not in the catalog (with a `×` but no checkbox) so they can be removed here.
  - Footer: "Manage tags…" link — navigates to global Settings view, Tags section.

- `components/SettingsView.tsx` (new top-level view, not a modal)
  - Shell mirrors how the **Logs** view is wired in `App.tsx`.
  - Top bar: `← Back` button (returns to office) + title "Settings".
  - Body: a single left-rail list with sections. For v1, only one section: **Tags**. Extensible: a `sections: { id, label, Component }[]` array in the view.
  - Tags section mirrors the layout of `RoomDetailsTab`:
    - `.panel` root, `.field` blocks, `.hint` caption text, `.actions` footer with Saving/Saved/Unsaved indicator.
    - Table of catalog rows: drag handle • color swatch • label input • delete icon.
    - "+ Add tag" row at bottom (label input + color picker → appends).
    - Debounced auto-save (800 ms) → `PUT /api/tags` with the full `entries[]`.
    - Color picker: 12-swatch preset palette + free hex input; invalid hex disables save and shows inline error.

**Render changes:**

- `components/Office.tsx` `HeaderMenu` (lines 39–104)
  - Add a new `<button role="menuitem">` entry: **Settings** (gear icon). Calls new `onSettings` prop.
- `components/App.tsx`
  - Add `view: "office" | "logs" | "settings"` state (or extend existing). Wire the `onSettings` prop on `HeaderMenu`. Render `<SettingsView />` when active.
- `components/Worker.tsx`
  - New row under the name: all pills (`size="sm"`), wrapped to as many lines as needed (no overflow cap).
  - Hide row when `session.tags` is empty/undefined.
  - When the worker card width is below 72 px, collapse the row into a single horizontal dot strip (one 6px dot per tag, wrapped) to stay readable.
- `components/DetailPanel.tsx` (`headerMain` block around line 2309)
  - Row under `sessionName`: all pills (`size="md"`), wrapping, followed by `+ tag` button.
  - Pill × removes with a 5 s undo toast.

**Styling:**
- New `TagPill.module.css`, `TagPicker.module.css`, `SettingsView.module.css`.
- `SettingsView.module.css` copies tokens from `RoomDetailsTab.module.css` (`.panel`, `.field`, `.label`, `.hint`, `.actions`, `.statusMuted`, `.saved`, `.error`) so the look matches exactly. Prefer reusing the same tokens via shared CSS custom properties if already defined, otherwise duplicate classes.

**UX rules:**
- Picker stays open across toggles.
- Assignment is optimistic; rolls back on HTTP error.
- Catalog edits auto-save (debounced 800 ms), just like the room description field.
- Typing a new label in the picker is also optimistic — it appears on the session immediately; if the server rejects (e.g. >40 chars), roll back and show inline error.
- No per-session tag cap. Pills wrap naturally in the header. Worker card wraps too.
- Deleting a catalog entry does NOT strip it from sessions; the session just renders the label in neutral color afterward. This is the user's explicit preference.

---

### Acceptance Criteria

**Server**
- [ ] `GET /api/tags` on a fresh install returns the 3 seeded entries with labels `In review`, `Planning`, `Implementing` and colors `#6366f1`, `#f59e0b`, `#10b981` in that order.
- [ ] `PUT /api/tags` with a well-formed body replaces the catalog; a subsequent `GET` returns the new entries in the submitted order.
- [ ] `PUT /api/tags` rejects with 409 when two entries share a case-insensitive label.
- [ ] `PUT /api/tags` rejects with 400 when any color is not `/^#[0-9a-f]{6}$/i` or any label is empty after trim / longer than 40 chars.
- [ ] `PUT /api/sessions/:sessionId/tags` persists the array onto the matching `OverlordSession.tags`; server trims each label and dedupes case-insensitively, preserving first-seen casing.
- [ ] Tags survive `/clear` (stored on `OverlordSession`, not `Session`).
- [ ] Deleting a catalog entry does not alter any session's `tags` array.
- [ ] `OfficeSnapshot` includes `tags: string[]` on each session whose `OverlordSession` has a non-empty tag list.
- [ ] `tags:changed` WS frame is broadcast within 200 ms of a catalog mutation.

**Client — rendering**
- [ ] Worker card shows pills (`size="sm"`) under the session name, wrapping to multiple lines if needed. No overflow cap.
- [ ] Worker card below 72 px width falls back to a dot strip (one 6 px dot per tag).
- [ ] DetailPanel header shows pills (`size="md"`) under the name, wrapping, followed by a `+ tag` button.
- [ ] Pill color comes from the catalog (case-insensitive match); labels with no catalog entry render in neutral grey.

**Client — picker**
- [ ] `+ tag` opens `TagPicker`; catalog entries list with checkboxes reflecting current assignment (case-insensitive).
- [ ] Typing a label and pressing Enter in the picker adds it to the session even if the catalog has no entry.
- [ ] Toggling a checkbox adds/removes the catalog's canonical-cased label from the session (optimistic, PUT to server).
- [ ] Session-only labels (not in catalog) are listed in the picker with a × for removal.
- [ ] "Manage tags…" navigates to Settings → Tags section.

**Client — settings**
- [ ] Burger menu in the top header shows a **Settings** item that opens `SettingsView`.
- [ ] `SettingsView` has a back button that returns to the office view.
- [ ] Tags section visually matches `RoomDetailsTab` (panel, labels, hint text, status indicator).
- [ ] Rows: drag-reorder handle, color swatch (opens palette + hex input), label input, delete button. All three built-ins are deletable.
- [ ] "+ Add tag" row appends a new entry.
- [ ] Edits debounce for 800 ms, then `PUT /api/tags`. Status indicator shows Saving / Saved / Unsaved / error, same as room description.
- [ ] Duplicate label entry (case-insensitive) shows inline error and blocks save; existing saved state is preserved.

**Performance**
- [ ] Catalog GET < 50 ms p50 on localhost.
- [ ] Tag assignment UI update < 100 ms p50 (optimistic).
- [ ] Catalog save round-trip < 200 ms p50 on localhost.

---

### Out of scope

- Filtering or grouping the office view by tag (v2).
- AI auto-assignment from activity.
- Per-tag notifications.
- Cross-machine sync of the catalog.
- Tag history / audit log on a session.
- Bulk-assign UI across multiple sessions.
- Other settings sections beyond Tags (the view is designed to accept more, but none are defined here).

### Resolved decisions

1. Re-typed casing: **dedupe case-insensitively, keep first-seen casing**.
2. Palette: **12 swatches** — seed 3 + `#ef4444 #ec4899 #a855f7 #3b82f6 #0ea5e9 #14b8a6 #84cc16 #eab308 #f97316`.
3. Settings view: **top-view toggle** like Logs.
4. Neutral color: `#64748b` slate-500 at 18% α.
5. Picker does **not** allow inline recolor/rename; catalog edits live in Settings only.
