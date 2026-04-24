# Spec Driven Development (SDD)

## Workflow

1. **Spec first** — produce a spec before any code. Defines goal, inputs, outputs, acceptance criteria, edge cases.
2. **Review** — present spec inline in chat (full content, not a link). Get explicit approval. Do not implement until agreed.
3. **Plan** — derive plan from spec. Write to `specs/<name>.plan.md`. Walk in order: **Server → Client → Verification**. Each step maps to ≥1 AC. Mirror as `TaskCreate` entries. Present for confirmation.
4. **Implement** — only what the spec covers. Mark tasks `in_progress` → `completed` one at a time.
5. **Verify** — confirm each AC is met. Flag anything unverifiable.

## Spec Format

```
## Spec: <feature name>

**Goal:** One sentence.
**Placement:** Where in UI/system. `_N/A_` if purely backend.

---

### Inputs / Triggers
- What initiates this (user action, event, lifecycle hook).

### Outputs / Side effects
- What the system produces, writes, broadcasts, or mutates.

---

### Server
Sub-sections as needed. Show TypeScript interfaces inline. Algorithms as numbered steps.
`_N/A_` if no server component.

### Client
Sub-sections as needed. Reference components/CSS by path. Name new files explicitly.
`_N/A_` if no client component.

---

### Acceptance Criteria

**Server**
- [ ] …

**Client**
- [ ] …

**Performance**
- [ ] …

---

### Out of scope
- …

### Open questions
1. Question? Suggest: …
```

## Rules

- Every AC: objectively verifiable — no "feels right". Use concrete numbers, paths, exact strings (e.g. "≤60 chars", "<200ms p50").
- Name files/endpoints/types by exact path.
- Every open question ends with `Suggest: …`.
- Check `specs/` for existing spec before writing new one.
- Never start implementing before spec is approved.
- New requirement during impl → stop, update spec first.

## Think Before Coding

1. Trace data flow end-to-end — what does each approach assume? What breaks?
2. Consider ≥2 alternatives — compare tradeoffs before picking.
3. Verify CLI flags/APIs — what do they actually do? Where do they write?
4. One well-thought approach beats three hasty iterations.

If starting a second approach after the first failed — pause. The root cause points to the right solution.
