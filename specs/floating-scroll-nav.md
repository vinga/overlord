# Spec: Floating scroll nav in conversation transcripts

**Goal:** Give users a fast way to jump to meaningful boundaries (bubble, agent, session) in long conversations using two progressive-scope buttons.

**Inputs / Triggers:**
- User opens a session's or subagent's `Conversation` tab.
- User scrolls the transcript container.
- User may be inside an inline-expanded agent block and/or inside an internally scrollable bubble.

**Outputs / Side effects:**
- Vertical pill at bottom-right of the scroll viewport with one up and one down button.
- Each click jumps to the **nearest applicable boundary in that direction**. Progressive: repeated clicks zoom out.

**Scope priority (nearest → farthest):**
1. Bubble — a `.transcriptBubble` element containing viewport center whose height is ≥ 2× viewport height ("long bubble"). Jump scrolls the outer scroll area to that bubble's top/bottom boundary.
2. Agent — inline-expanded agent block containing viewport center. Jump scrolls outer to agent block's top/bottom.
3. Session — the outer transcript scroll area. Jump scrolls to 0 or scrollHeight.

Thresholds:
- Bubble counts only if height ≥ 2× viewport height.
- Each direction is "actionable" only if ≥ 200px of room remains to the boundary.

**Visual indicator:**
Each arrow button displays 1/2/3 small dots underneath, showing the scope of its next action: `•` bubble, `••` agent, `•••` session.

**Click semantics:**
- `↑` finds the nearest above boundary in scope order: if inside a bubble AND bubble not at top → jump bubble to top. Else if inside an agent block AND outer scrolled past agent top → scroll outer to agent top. Else → scroll outer to session top.
- `↓` mirrors: bubble bottom → agent end → session latest.
- Smooth scroll (or instant with `prefers-reduced-motion`).

**Visibility:**
- `↑` shown if any up-direction action would move the view.
- `↓` shown if any down-direction action would move the view.
- Pill hidden when neither is actionable.
- Tooltip on hover labels the **next** action (e.g. "Agent start", "Session latest").

**Acceptance Criteria:**
- [ ] Pill hidden on short content (no scroll).
- [ ] Pill hidden at bottom of short session with no agent/bubble.
- [ ] Inside an expanded agent block, mid-scroll: `↑` tooltip reads "Agent start", click scrolls outer so agent block top aligns near viewport top; after that, next `↑` click reads "Session top".
- [ ] Inside a scrollable bubble, mid-scroll: `↑` tooltip reads "Bubble top", clicks scrolls bubble's own scrollbar to 0; after that, next `↑` acts on agent (if present) then session.
- [ ] Without any agent/bubble, pill behaves as simple session top/bottom jump.
- [ ] Pill styling: compact vertical two-button unit, dark semi-transparent, rounded, divider between up/down.
- [ ] Works for session view and subagent view.
- [ ] Respects `prefers-reduced-motion`.

**Out of scope:**
- Keyboard shortcuts.
- Collapse-all.
- Jump-to-next/prev agent (only boundaries of the current agent block).

**Open questions:** none — approved.
