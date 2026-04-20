# Plan: Chat selection → Explain action

Derived from `specs/chat-selection-explain.md`. No server section — feature is client-only.

## Client

- [ ] **1. Add `quoteSelection` helper** — new util (inline in `SelectionMenu.tsx`) that splits `selection.toString()` on `\n`, trims outer blank lines, prefixes each remaining line with `> ` (empty mid-lines → `>`). _Satisfies ACs: "Multi-line selections preserve original line breaks; blank lines between lines are emitted as `>`"._

- [ ] **2. Create `SelectionMenu.tsx`** — new component at `packages/client/src/components/SelectionMenu.tsx`. Props: `containerRef`, `onExplain`. Subscribes to `document` `selectionchange`. Validates selection is non-empty, non-whitespace, and contained in `containerRef`. Renders floating pill at `range.getBoundingClientRect()`. Flips below if no room above. Closes on `Escape`, mousedown outside, collapsed selection. _Satisfies ACs: menu visibility/position/close rules._

- [ ] **3. Create `SelectionMenu.module.css`** — pill styling: rounded, shadow, backdrop blur, `⌘` glyph + 13px label. `pointer-events: none` on container, `auto` on button. _Satisfies AC: "menu positioned above the selection's bounding rect; clamps to viewport"._

- [ ] **4. Add `feedContainerRef` to `DetailPanel.tsx`** — attach `ref={feedContainerRef}` to the scrollable feed wrapper containing the activity segments. _Satisfies AC: "Menu does NOT appear for selections outside the feed"._

- [ ] **5. Wire `<SelectionMenu />` into `DetailPanel`** — mount at panel root; `onExplain={handleExplain}`. _Satisfies ACs: auto-send, input unchanged._

- [ ] **6. Implement `handleExplain(quoted)` in `DetailPanel.tsx`** — build `Explain:\n\n${quoted}` and invoke existing `sendText(full)` helper (same path as `handleSend`, to keep optimistic bubble). Do NOT touch `sendInput2`. _Satisfies ACs: auto-send via existing path, chat input unchanged, optimistic bubble appears._

## Verification

- [ ] **7. Walk acceptance criteria** — re-read `specs/chat-selection-explain.md` ACs and tick each one off against the implementation.

- [ ] **8. Browser self-verify** (Chrome DevTools MCP at `http://localhost:5173`):
  - Start `npm run dev` if not running.
  - Open a session with feed content.
  - Select text in an assistant message → menu appears above selection.
  - Select text in a user message → menu appears (any text).
  - Select text in terminal embed → menu does NOT appear.
  - Click **Explain** → message auto-sent, quoted correctly, input untouched, menu closes.
  - Multi-line selection → `> `-prefixed lines, blank lines become `>`.
  - `Escape` closes menu; mousedown outside closes menu.
  - Check console for errors/warnings.
  - Screenshot and critically evaluate the menu's visual polish per CLAUDE.md design standard.
