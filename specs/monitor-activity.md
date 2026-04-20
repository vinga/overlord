## Spec: active Monitor tracking

**Goal:** Surface active `Monitor` tool_use calls per session so the office view shows which sessions are currently streaming output from a background process.

**Placement:** Worker card pill (alongside existing state indicators) and a section in `DetailPanel` above the activity feed.

---

### Inputs / Triggers

- Assistant calls the `Monitor` tool → `tool_use` block appears in the transcript `.jsonl`.
- Transcript change event (chokidar, `transcriptWatcher.ts`) triggers a re-read via `readTranscriptState()`.
- Tool completes → matching `tool_result` with same `tool_use_id` appears.

### Outputs / Side effects

- `TranscriptSummary.activeMonitors` populated when an unmatched `Monitor` `tool_use` exists.
- Propagated onto `Session.activeMonitors` in the `OfficeSnapshot` broadcast.
- Rendered as a pill on `Worker` card and a line item section in `DetailPanel`.

---

### Server

**New type** (`packages/server/src/session/transcriptReader.ts`):

```ts
export interface ActiveMonitor {
  toolUseId: string;
  target: string;        // best-effort: input.shellId ?? input.taskId ?? input.id ?? ''
  startedAt?: string;    // tool_use timestamp (ISO)
  until?: string;        // input.until (regex), if any
}
```

Add `activeMonitors?: ActiveMonitor[]` to the `TranscriptSummary` return shape (alongside `detectedPlans` at `transcriptReader.ts:517`).

**Detection** — inside the existing reverse loop that captures `detectedPlans` at `transcriptReader.ts:673`:

1. When `block.name === 'Monitor'` and `block.id` is present, look up `toolResults.get(block.id)` (pre-built map at `transcriptReader.ts:587`).
2. If absent → push to a local `activeMonitors` array.
3. If present → skip (monitor completed).

Extract `target`, `until` from `block.input`. Include `parsed.timestamp` as `startedAt`. No new I/O.

**Emit** — include `activeMonitors: activeMonitors.length > 0 ? activeMonitors : undefined` in the return object at `transcriptReader.ts:900`.

**State propagation** (`packages/server/src/types.ts` + `stateManager.ts`):

- Add `activeMonitors?: ActiveMonitor[]` to `Session` (broadcast shape, line 76+) and `LiveSession` (runtime shape, line 227+).
- In `stateManager.ts` where transcript summary is applied (near line 809, the `detectedPlans` handling), copy `transcript.activeMonitors` onto the live session.
- Included in `OfficeSnapshot.sessions[*]`.

### Client

**Types** (`packages/client/src/types.ts`): mirror `ActiveMonitor` and add `activeMonitors?: ActiveMonitor[]` to the client-side `Session` type.

**Render:**

- `Worker.tsx` — small pill "Monitoring" (add count suffix "×N" when `N>1`) shown iff `activeMonitors.length > 0`. Placed next to plan pill. Tooltip lists each `target` (and `until` if set), one per line.
- `DetailPanel.tsx` — a dedicated "Watching" section above activity feed, rendered only when `activeMonitors.length > 0`, listing each target + `until` pattern.

**Styling:** reuse existing pill styles in `Worker.module.css` (same family as plan/ack pills). Add a pulsing dot to convey live streaming.

---

### Acceptance Criteria

**Server**
- [ ] `TranscriptSummary.activeMonitors` contains every `Monitor` `tool_use` whose `tool_use_id` has no matching `tool_result` in the last-30 tail window.
- [ ] When the `tool_result` for that id appears, the entry is absent from the next snapshot.
- [ ] `Session.activeMonitors` in `OfficeSnapshot` equals the transcript output.
- [ ] No additional transcript file reads (reuses `toolResults` pre-pass).
- [ ] Omitted entirely (not present / undefined) when no active monitors.

**Client**
- [ ] Worker card shows a "Monitoring" pill iff `session.activeMonitors && activeMonitors.length > 0`.
- [ ] Pill renders `Monitoring ×N` when `N > 1`, otherwise `Monitoring`.
- [ ] Pill tooltip lists each monitor's `target` and its `until` regex if set.
- [ ] Pill disappears within one snapshot (≤2s) after the monitor completes.
- [ ] `DetailPanel` "Watching" section renders only when ≥1 active monitor; hides otherwise.

**Performance**
- [ ] Zero extra transcript I/O: detection piggybacks on existing reverse loop and `toolResults` map.

---

### Out of scope

- Persisting monitors across server restarts.
- Showing monitor output / streaming lines in Overlord UI.
- Tracking completed monitors' durations or history.
- Handling non-Claude-Code providers (Codex transcripts).

### Open questions

1. Pill shows count when `>1`? Suggest: yes — "Monitoring ×2".
2. Pill placement on `Worker.tsx`? Suggest: next to plan pill (same row, same style family).
3. `DetailPanel` section style? Suggest: dedicated "Watching" header line above activity feed, removed when empty.
