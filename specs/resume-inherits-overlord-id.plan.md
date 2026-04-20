# Plan: Resume inherits parent overlordId

Spec: `specs/resume-inherits-overlord-id.md` (inline approved)

## Server

- [ ] **stateManager.ts:750** — After resolving `resumedFrom`, attempt to resolve parent's `overlordId` via `sessionStore.resolveOverlordId(resumedFrom)` or `this.sessions.get(resumedFrom)?.overlordId` before falling back to `generateOvrId()`.
  Satisfies: new session's overlordId equals parent's overlordId.

- [ ] **sessionStore.ts:ensureFromLive** — Pass `reason: 'resume'` in LineageEntry when `live.resumedFrom !== undefined` and we're attaching a new sid to an existing ovrId.
  Satisfies: lineage history records reason correctly.

- [ ] **stateManager.ts** — When resume inherits parent's ovrId, mark `parentSession.replacedBy = newSessionId` (mirror `/clear` behavior in `transferSessionState`).
  Satisfies: closed parent stays out of active views.

## Verification

- [ ] Walk acceptance criteria
- [ ] Browser / self-verify: resume "OV General PLAN" → single ovr record gains new lineage entry; no new ovr file
