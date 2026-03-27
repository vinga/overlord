# Update Spec Skill

You are updating a spec file in the `specs/` directory of this project, following the Spec Driven Development (SDD) workflow defined in CLAUDE.md.

## Workflow

1. **Read the existing spec** — read the relevant file in `specs/` to understand the current state.
2. **Identify what to update** — based on the user's request, determine which sections need to change:
   - Goal, Inputs/Triggers, Outputs/Side effects
   - Acceptance Criteria (add, check off, or remove items)
   - Out of scope
   - Open questions (resolve or add new ones)
3. **Make the edit** — use the Edit tool to update the spec file precisely. Do not rewrite sections that haven't changed.
4. **Confirm** — briefly summarize what changed in the spec.

## Rules

- Acceptance criteria use `- [x]` for completed, `- [ ]` for pending.
- When a feature is implemented and verified, mark its criteria `[x]`.
- When adding new requirements, add them as `- [ ]` criteria.
- Keep the spec format consistent with the existing file structure.
- Never remove acceptance criteria — mark them complete instead.
- If the user describes a new feature, add it as a new section following the spec format from CLAUDE.md:

```
## Spec: <feature name>

**Goal:** One-sentence description.

**Inputs / Triggers:** What initiates this behavior.

**Outputs / Side effects:** What the system produces or changes.

**Acceptance Criteria:**
- [ ] Criterion 1

**Out of scope:** What this explicitly does NOT cover.

**Open questions:** Anything needing clarification.
```

## Spec files

All specs live in `specs/` at the project root. The main spec is `specs/claude-office-monitor.md`.

## Execution

Read the spec file, apply the requested update, confirm what changed. Do not ask for confirmation before editing unless the request is genuinely ambiguous.