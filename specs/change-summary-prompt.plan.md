## Plan: Change Summary prompt command

Derived from `specs/change-summary-prompt.md`. Order: Client → Verification (no server work).

## Client

- [ ] **Create `packages/client/src/components/quickPrompts.ts`** with `QuickPrompt` interface and `QUICK_PROMPTS` array containing the 3 existing presets (`remind`, `cut-fluff`, `pr-review`) plus `change-summary`. (AC: new file exists; four entries in order)
- [ ] **Move existing preset bodies** (the big `[...].join("\n")` strings currently inline in `DetailPanel.tsx` around L2894–L2983) into `quickPrompts.ts` verbatim. (AC: no inline preset body strings remain in `DetailPanel.tsx`)
- [ ] **Add Change Summary body** to `quickPrompts.ts` per spec. (AC: 4th entry present, label "Change Summary")
- [ ] **Refactor `DetailPanel.tsx` burger menu** to `QUICK_PROMPTS.map(...)` over buttons; preserve `onMouseDown` semantics (preventDefault, close menu, `sendText(p.body)`), className, key by `p.id`. (AC: menu items rendered from array)

## Verification

- [ ] **Walk acceptance criteria** — tick off each Client AC from the spec.
- [ ] **Browser / self-verify** — open `http://localhost:5173`, open a session, click burger, confirm 4 items render in order, label spelling, no console errors, and each item closes the menu on click. Screenshot via Chrome DevTools MCP.
- [ ] **Lint/typecheck** — run client lint/`tsc --noEmit` if configured.
