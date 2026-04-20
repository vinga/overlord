## Spec: Chat selection → Explain action

**Goal:** Let the user select text in the conversation feed and send an "Explain:" prompt to the session with the selection quoted in markdown.

**Placement:** `DetailPanel` activity feed — the scrollable area that renders assistant/user/thinking/tool messages.

---

### Inputs / Triggers

- User performs a text selection (mouse drag or keyboard) that produces a non-empty `window.getSelection()` range inside the feed container.
- Selection must be contained within the feed area (assistant messages, user messages, thinking blocks). Selections in terminal embed, header, or input area do NOT trigger.
- Menu closes on: selection cleared, click outside menu, `Escape`, or clicking the Explain button.

### Outputs / Side effects

- A floating action menu rendered above the selection with a single button: `⌘` icon + "Explain" label.
- On click: a chat message is **auto-sent** via the existing send path (same as `handleSend` in `DetailPanel.tsx`):

  ```
  Explain:

  > <selected line 1>
  > <selected line 2>
  ```

  Multi-line selections quote each line with `> `. Blank lines between quoted lines become `>`. Leading/trailing empty lines trimmed.
- The chat input field (`sendInput2`) is NOT modified.
- Selection collapses and the menu hides immediately after click.

---

### Server

_N/A_ — purely client-side; uses existing send path.

### Client

**New file:** `packages/client/src/components/SelectionMenu.tsx` + `SelectionMenu.module.css`

- Props: `containerRef: RefObject<HTMLElement>`, `onExplain: (quotedText: string) => void`.
- Internally subscribes to `document` `selectionchange`.
- When selection has ≥1 non-whitespace char AND `selection.anchorNode` + `selection.focusNode` are both inside `containerRef.current`, compute bounding rect via `range.getBoundingClientRect()` and render a pill menu absolutely positioned just above the top of the rect (or below if no room). Position clamped to viewport.
- Menu is a small Raycast/Linear-style floating bar: rounded pill, backdrop blur, subtle shadow, 13px label, `⌘` glyph icon before "Explain".
- Hides when selection collapses, mousedown happens outside the menu element, or `Escape` is pressed.
- `pointer-events: none` on container, `pointer-events: auto` on the button, so the user can freely interact with text while menu is shown.

**Integration in `DetailPanel.tsx`:**

- Add `feedContainerRef: RefObject<HTMLDivElement>` on the scrollable feed element.
- Mount `<SelectionMenu containerRef={feedContainerRef} onExplain={handleExplain} />` at the panel root.
- `handleExplain(quoted)` builds `Explain:\n\n${quoted}` and calls the existing `sendText(...)` helper — same path as `handleSend`, so locally-sent optimistic bubble appears.
- Helper `quoteSelection(selection: Selection): string` — reads `selection.toString()`, splits on `\n`, trims outer blank lines, prefixes each remaining line with `> ` (empty mid-lines become `>`).

**Styling:** match existing pill button aesthetic (`permissionBtn` in `DetailPanel.module.css` as reference) — rounded corners, subtle shadow, backdrop blur, small icon + 13px label.

---

### Acceptance Criteria

**Client**
- [ ] Selecting ≥1 non-whitespace char inside the feed shows the Explain menu within 1 frame of `selectionchange`.
- [ ] Menu positions above the selection's bounding rect; clamps to viewport when near edges (flips below if no room above).
- [ ] Menu does NOT appear for selections outside the feed (terminal, header, input, side panels).
- [ ] Clicking **Explain** sends a message `Explain:\n\n` + quoted selection via the existing send path; the message appears as a locally-sent user turn (optimistic bubble).
- [ ] Chat input (`sendInput2`) is unchanged after click.
- [ ] Menu closes immediately after click; selection collapses.
- [ ] Menu closes on `Escape`, on mousedown outside menu, and when the selection collapses.
- [ ] Multi-line selections preserve original line breaks; blank lines between lines are emitted as `>`.
- [ ] No console errors during select/insert/close.

**Performance**
- [ ] Menu render/position update ≤8ms on `selectionchange`.

---

### Out of scope

- Additional menu actions (Summarize, Translate, etc.) — Explain only for v1.
- Selection inside terminal (xterm) — xterm has its own selection handling.
- Populating the input instead of auto-sending.
- Persisting or re-using previous selections.

### Open questions

_None — resolved during review:_
1. Auto-send instead of populating input? **Resolved: auto-send.**
2. Trigger on user messages too? **Resolved: any text in the feed.**
3. Icon choice? **Resolved: `⌘` command glyph.**
4. Prompt wording? **Resolved: `Explain:`**
