## Spec: Room Search Tab

**Goal:** Add a Search tab to `RoomDetailPanel` that lets users query conversation content across all sessions in the room, returning matching agents with highlighted conversation fragments.

**Inputs / Triggers:**
- User clicks the "Search" tab in `RoomDetailPanel`.
- User types into the search input that appears.

**Outputs / Side effects:**
- Read-only, client-side only. No server requests, no state mutations.
- Search runs against all `activityFeed` items of all sessions (and their subagents) in the room.

---

**Acceptance Criteria:**

**Tab Presence & Layout**
- [ ] A "Search" tab (icon: magnifying glass or label "Search") appears in the `RoomDetailPanel` tab bar alongside any existing tabs.
- [ ] Clicking the tab shows a search input field, auto-focused, with placeholder "Search conversations…".
- [ ] The search input has a clear (×) button that resets results and clears the query.

**Search Behavior**
- [ ] Search is case-insensitive, substring match against `ActivityItem.content` for all items in `session.activityFeed` (and `subagent.activityFeed`) across all sessions in the room.
- [ ] Search fires on every keystroke (no debounce needed for client-side search, though 150ms debounce acceptable for large rooms).
- [ ] Empty query shows an empty state: "Type to search across sessions in this room."
- [ ] Query with no matches shows: "No results for «query»."

**Results Layout**
- [ ] Results are grouped by agent (session or subagent). Each group has:
  - Agent header: state dot + display name + session type badge (e.g. `bridge`, `embedded`) if applicable.
  - Up to 3 matching conversation fragments shown beneath the header (most recent first).
  - If more than 3 matches exist for an agent, a "N more matches" link expands to show all.
- [ ] Each fragment shows:
  - Role badge: `user` or `assistant` (or `tool` for tool calls), styled with existing role colors.
  - A ~120-character excerpt of `content` with the matched substring **bolded** (not highlighted with background color — bold is cleaner).
  - Relative timestamp (from `ActivityItem.timestamp`) if present, right-aligned, muted.
- [ ] Agents with more matches are sorted first.
- [ ] Clicking a fragment or an agent header closes the room panel and opens the session `DetailPanel` for that session (calls `onSelectSession`).

**Subagent Handling**
- [ ] Subagents of sessions are included in search. Their group header is indented slightly (8px) beneath their parent session to convey hierarchy.
- [ ] Subagent display name follows existing conventions: `agentType` + `description` truncated to 40 chars.

**Performance**
- [ ] No result pagination needed for typical room sizes (<20 sessions, <500 feed items). If total feed items across room exceed 2000, search is limited to the most recent 2000 items (across all sessions, sorted by timestamp desc) and a subtle notice is shown: "Showing most recent 2 000 items."

**Visual Design**
- [ ] Follows existing `DetailPanel` / `RoomDetailPanel` dark-theme conventions.
- [ ] Agent group headers use a subtle separator line between groups.
- [ ] Matched text is bolded using `<strong>` — no yellow highlight, no background color.
- [ ] Empty state and no-results state are centered, muted text — not error-styled.

---

**Out of scope:**
- Server-side search or full-text index.
- Searching across rooms (this tab lives inside one room).
- Searching session metadata (cwd, model, task labels) — content only.
- Persistent search history.
- Regex or advanced query syntax.

**Open questions:**
- Should `thinking` blocks (kind: `thinking`, isRedacted: true) be excluded from search? Suggest: exclude redacted thinking, include non-redacted thinking.
- Should tool input JSON (`inputJson`) be searchable in addition to `content`? Suggest: yes, include `inputJson` in the search corpus for power users looking for file paths or function names.
