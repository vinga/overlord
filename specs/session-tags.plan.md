# Plan: Session tags

Derived from `specs/session-tags.md`.

## Server

- [ ] **S1. Types** — add `TagEntry`, `TagCatalog` to `packages/server/src/types.ts`; extend `OverlordSession` with optional `tags?: string[]`. (AC: `OfficeSnapshot` carries tags; Session persistence schema)
- [ ] **S2. Catalog module** — create `packages/server/src/session/tagCatalog.ts` with `loadCatalog`, `saveCatalog`, `getColor`, `onCatalogChange`. Seed defaults on first read. Atomic write (temp + rename). In-memory cache + `fs.watch`. Validate labels (trimmed 1–40, case-insensitive unique) and colors (`/^#[0-9a-f]{6}$/i`). Returns 409-equivalent error for dupes; 400-equivalent for bad format. (AC: fresh install seeded; PUT rejects dupe 409; PUT rejects bad format 400)
- [ ] **S3. GET /api/tags** — handler in `packages/server/src/api/apiRoutes.ts` returning the catalog. (AC: GET returns seeded entries)
- [ ] **S4. PUT /api/tags** — handler validating + calling `saveCatalog`; translates validator errors to 400/409. Broadcast `tags:changed` on success. (AC: PUT replaces catalog; 409 dupe; 400 bad format; broadcast <200 ms)
- [ ] **S5. PUT /api/sessions/:sessionId/tags** — body `{ tags: string[] }`. Trim each label, reject empty / >40 chars with 400, dedupe case-insensitively preserving first-seen casing. Persist via `sessionStore.patchBySessionId(sessionId, { tags })`. 404 on unknown sessionId. (AC: persists to OverlordSession; trims + case-dedupes; 404 unknown session)
- [ ] **S6. Fold tags into live Session** — in `stateManager.ts`, include `tags` from `OverlordSession` on the live `Session` object alongside `intent`/`notes`, so `OfficeSnapshot` carries it. Tags survive `/clear` because they live on `OverlordSession`. (AC: OfficeSnapshot includes tags; survives /clear)
- [ ] **S7. WS broadcast** — in `packages/server/src/api/wsHandler.ts` (or `index.ts`), register `onCatalogChange` handler that sends `{ type: "tags:changed", catalog }` to all clients. (AC: tags:changed broadcast <200 ms)
- [ ] **S8. No delete-sweep** — `PUT /api/tags` replace does NOT touch any `OverlordSession.tags`. Add a test/assertion-path comment documenting this behavior. (AC: deleting catalog entry leaves session labels intact)

## Client

- [ ] **C1. Types mirror** — add `TagEntry`, `TagCatalog`, extend `Session.tags?: string[]` in `packages/client/src/types.ts`. (AC: pill row renders from session.tags)
- [ ] **C2. useTags hook** — create `packages/client/src/hooks/useTags.ts` exposing `catalog`, `loading`, `refresh`, `saveCatalog`, `assignToSession`, `colorFor`. Fetch on mount; subscribe to WS `tags:changed`; optimistic updates with rollback. (AC: catalog refresh on mount + tags:changed; optimistic assignment)
- [ ] **C3. TagPill component** — `components/TagPill.tsx` + `.module.css`. Two sizes `sm`/`md`. Hex→luminance helper; neutral `#64748b` fallback. Optional `onRemove` for ×. (AC: pills render with catalog color / neutral fallback; AA contrast)
- [ ] **C4. TagPicker component** — `components/TagPicker.tsx` + `.module.css`. Free-text input (Enter adds), catalog checkboxes, session-only labels with ×, "Manage tags…" footer that navigates to Settings. Case-insensitive toggle logic. (AC: picker lists catalog with checkboxes; Enter adds free-text; session-only labels shown; Manage link navigates)
- [ ] **C5. Worker card pill row** — edit `components/Worker.tsx` + `.module.css`. Wrap-row of `sm` pills under the name. Below 72 px card width, render 6 px dot strip fallback (one dot per tag, same colors). Hide row entirely when no tags. (AC: wrap-row, no cap; dot-strip below 72 px)
- [ ] **C6. DetailPanel header tag row** — edit `components/DetailPanel.tsx` around line 2309 (`headerMain`). New wrap-row of `md` pills + `+ tag` button that opens `TagPicker`. × on pill removes with 5 s undo toast. (AC: header shows pills + `+ tag`; × + undo)
- [ ] **C7. SettingsView scaffold** — new `components/SettingsView.tsx` + `.module.css`. Top bar with back button + "Settings" title. `sections: { id, label, Component }[]` array; v1 has only "Tags". Styles copy `RoomDetailsTab.module.css` tokens for `.panel`, `.field`, `.label`, `.hint`, `.actions`, status. (AC: view reachable; visual parity with RoomDetailsTab)
- [ ] **C8. Tags settings section** — component rendered inside `SettingsView`. Rows: drag handle, color swatch (opens 12-swatch palette + hex input popover), label input, delete. "+ Add tag" row appends. 800 ms debounced `PUT /api/tags`. Saving/Saved/Unsaved/error indicator mirrors RoomDetailsTab status. Case-insensitive duplicate shows inline error and blocks save. Invalid hex disables save with inline error. All built-ins deletable. Drag reorders entries in place. (AC: all Tags settings ACs)
- [ ] **C9. Burger menu entry** — in `components/Office.tsx` `HeaderMenu`, add **Settings** menu item that calls new `onSettings` prop. (AC: burger menu shows Settings)
- [ ] **C10. App view routing** — in `components/App.tsx`, extend the view state to include `"settings"`; wire `onSettings` from `HeaderMenu`; render `<SettingsView />` when active; back button returns to office. (AC: Settings view reachable + back button)
- [ ] **C11. WS client `tags:changed` handling** — wire the `tags:changed` frame through the existing WS client and fan it out to `useTags`. (AC: catalog refresh on tags:changed)

## Verification

- [ ] **V1. Walk acceptance criteria** — re-read `specs/session-tags.md` § Acceptance Criteria; mark each verified or flag blocker.
- [ ] **V2. Server smoke test** — curl each endpoint: `GET /api/tags` (seeded), `PUT /api/tags` happy path + 409 dupe + 400 bad color + 400 long label, `PUT /api/sessions/:sid/tags` happy + 400 bad label + 404 unknown session.
- [ ] **V3. Browser / self-verify** — at `http://localhost:5173` (start dev servers if down): open a session, open picker, tick a built-in, type a free-text tag + Enter, verify pills appear in header + worker card with correct colors. Wrap behavior: assign 8+ tags, confirm wrap. Open Settings from burger: add a new tag, recolor existing via swatch, drag-reorder, delete a built-in; confirm auto-save indicator cycles and `GET /api/tags` reflects the new state. Delete a catalog entry still assigned to a session — confirm that session's pill now renders neutral. Check console for errors.
- [ ] **V4. /clear persistence** — verify tags survive `/clear` by forcing a sessionId change in a test session (or by inspecting `~/.claude/overlord/overlord-sessions/{overlordId}.json` before/after).
