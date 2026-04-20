## Plan: active Monitor tracking

Derived from `specs/monitor-activity.md`. Walk: Server → Client → Verification.

## Server

- [ ] **S1. Add `ActiveMonitor` type + extend `TranscriptSummary`**
  - File: `packages/server/src/session/transcriptReader.ts` (near line 517)
  - Export `ActiveMonitor` interface; add `activeMonitors?: ActiveMonitor[]` to return shape.
  - AC: server "Omitted entirely… when no active monitors", "Session.activeMonitors in OfficeSnapshot equals the transcript output".

- [ ] **S2. Detect unmatched `Monitor` tool_use blocks**
  - File: `packages/server/src/session/transcriptReader.ts` (inside loop at line 673)
  - When `block.name === 'Monitor'` and `block.id`, check `toolResults.get(block.id)`; push `{toolUseId, target, startedAt, until}` when absent.
  - Return via object at ~line 900: `activeMonitors: activeMonitors.length > 0 ? activeMonitors : undefined`.
  - AC: server "contains every Monitor tool_use whose tool_use_id has no matching tool_result", "absent from the next snapshot", "No additional transcript file reads".

- [ ] **S3. Propagate through `Session` / `LiveSession` types**
  - File: `packages/server/src/types.ts`
  - Add `activeMonitors?: ActiveMonitor[]` to both `Session` (broadcast) and `LiveSession` (runtime). Re-export `ActiveMonitor` from transcriptReader or declare here.
  - AC: server "Session.activeMonitors in OfficeSnapshot equals the transcript output".

- [ ] **S4. Copy transcript output onto live session in stateManager**
  - File: `packages/server/src/session/stateManager.ts` (near line 809 where `detectedPlans` is consumed)
  - Assign `live.activeMonitors = transcript?.activeMonitors` each refresh.
  - AC: same as S3.

## Client

- [ ] **C1. Mirror types**
  - File: `packages/client/src/types.ts`
  - Add `ActiveMonitor` type + `activeMonitors?: ActiveMonitor[]` on client `Session`.
  - AC: required by all C* steps.

- [ ] **C2. "Monitoring" pill on Worker card**
  - File: `packages/client/src/components/Worker.tsx` + `Worker.module.css`
  - Render pill next to plan pill when `activeMonitors?.length > 0`. Suffix `×N` when `N > 1`. Tooltip = targets and `until`.
  - Style: reuse existing pill family; add pulsing dot.
  - AC: client "Worker card shows a Monitoring pill iff…", "renders Monitoring ×N when N > 1", "tooltip lists each monitor's target".

- [ ] **C3. "Watching" section in DetailPanel**
  - File: `packages/client/src/components/DetailPanel.tsx` + `DetailPanel.module.css`
  - Above activity feed, render a section listing active monitors with target + `until`. Hide when none.
  - AC: client "DetailPanel Watching section renders only when ≥1 active monitor; hides otherwise".

## Verification

- [ ] **V1. Walk acceptance criteria** — tick every [ ] in the spec.
- [ ] **V2. Browser self-verify** — open `http://localhost:5173`, find a session with an active Monitor (or induce one via a test transcript), confirm pill appears/disappears within ≤2s of tool_result.
- [ ] **V3. Snapshot shape sanity** — inspect a WebSocket snapshot payload in DevTools console, confirm `activeMonitors` field is present only when populated.
