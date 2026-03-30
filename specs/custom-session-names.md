## Spec: Custom Session Names

**Goal:** Allow users to rename Claude sessions to meaningful labels that override auto-generated names, persisted locally in the browser.

**Inputs / Triggers:**
- User opens the DetailPanel for a session (by clicking a Worker)
- User interacts with the rename dialog/input inside DetailPanel
- Page load restores previously saved names from localStorage

**Outputs / Side effects:**
- Custom name replaces the auto-generated `proposedName` wherever a session label is displayed
- Custom name is persisted to `localStorage` under the key `customNames` (Map<sessionId, string>)
- Clearing a custom name (submitting empty string) resets display back to `proposedName` or sessionId prefix
- No server-side state is modified; this is entirely client-side

**Acceptance Criteria:**
- [ ] Session label display follows this priority: `customName` (if set) → `proposedName` (if available) → truncated `sessionId` prefix
- [ ] Custom name is shown in the Worker character label beneath the avatar
- [ ] Custom name is shown in the DetailPanel header/title area
- [ ] Custom name is shown in any Room-level label that displays the session name
- [ ] Rename is triggered from the DetailPanel via a visible rename affordance (e.g., pencil icon, "Rename" button, or click-to-edit label)
- [ ] Clicking the rename affordance opens an inline input field or dialog pre-filled with the current display name (custom or auto-generated)
- [ ] Submitting a non-empty name saves it as the custom name for that sessionId
- [ ] Submitting an empty name (or clearing the field and confirming) deletes the custom name entry, reverting display to `proposedName` or sessionId prefix
- [ ] Custom names are trimmed of leading/trailing whitespace before saving; a name that is all whitespace is treated as empty (clear)
- [ ] Maximum custom name length is 60 characters; input is capped or validated at this limit
- [ ] Custom names survive page reload (persisted to `localStorage['customNames']`)
- [ ] Custom names are scoped to `sessionId`; renaming one session does not affect others
- [ ] If a session is removed and re-added with the same `sessionId`, the saved custom name is restored
- [ ] Rename can be cancelled (Escape key or cancel button) without changing the current name
- [ ] The rename input is submitted on Enter key or explicit confirm action

**Out of scope:**
- Server-side persistence or sync of custom names across browsers/machines
- Renaming rooms (workspace groups) — only individual sessions are renamed
- Bulk rename or name templates
- Exporting/importing custom names
- Custom names influencing `proposedName` generation logic in `transcriptReader.ts`
- Any UI changes to `WorkerGroup` beyond passing the name through to `Worker`

**Open questions:**
- Should the rename affordance be visible at all times in DetailPanel, or only on hover?
- Should the Worker label in the office view show a visual indicator (e.g., italic, icon) when a custom name is active vs. auto-generated?
- Is 60 characters the right cap, or should it be shorter (e.g., 40) given the constrained width of Worker labels?
- Should clearing a name show a confirmation prompt, or is immediate revert on empty submit acceptable?
