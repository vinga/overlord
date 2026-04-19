## Spec: ACK status — silence WAITING bubble without marking done

**Goal:** Add a manual ACK status that silences the pulsing WAITING bubble in the room without marking the session as DONE.

**Placement:** Worker indicator menu (next to "Set to Done") and DetailPanel StateBadge.

---

### Inputs / Triggers

- User clicks "ACK" in Worker indicator menu.
- User clicks "ACK" / "Un-ack" in DetailPanel StateBadge.
- POST to new endpoint `POST /api/sessions/:sessionId/ack` (toggle).
- Auto-clears when the session transitions out of `waiting` (e.g. user input detected in transcript, same path that clears `completionHint`).
- `/clear` resets the flag.

### Outputs / Side effects

- New field `acknowledged: boolean` on session snapshot (server + client types).
- Persisted to disk via `taskStorage` alongside completion hint.
- Snapshot broadcast includes `acknowledged`.
- While `acknowledged && state === 'waiting' && !isDone && !needsPermission`:
  - Worker bubble hidden — no pulsing, no "waiting" label.
  - Room collapsed chips exclude acknowledged from `waiting` count.

---

### Server

**Types** (`packages/server/src/types.ts`)
- Add `acknowledged?: boolean` to the session snapshot interface.

**stateManager** (`packages/server/src/session/stateManager.ts`)
- Add `markAckByUser(sessionId)` that toggles `acknowledged` and persists.
- Clear `acknowledged = false` anywhere `completionHint` is cleared on user input (line ~1375).
- Clear `acknowledged = false` on `/clear` transfer.
- Include `acknowledged` in snapshot emission.

**Persistence** (`packages/server/src/ai/taskStorage.ts`)
- Add `saveAck(sessionId, acknowledged)` parallel to `saveCompletionHint`.
- Load on session init.

**Endpoint** (`packages/server/src/api/apiRoutes.ts`)
- `POST /api/sessions/:sessionId/ack` → calls `stateManager.markAckByUser`. Returns `{ acknowledged }`.

### Client

**Types** (`packages/client/src/types.ts`)
- Mirror `acknowledged?: boolean`.

**Worker** (`packages/client/src/components/Worker.tsx`)
- `WaitingIndicator`: if `acknowledged && !isDone && !needsPermission && !isSubagent` → return `null`.
- Indicator menu (`Worker.tsx:265-277`): add "✓ ACK" / "↺ Un-ack" button that posts to `/api/sessions/:id/ack`.

**Room** (`packages/client/src/components/Room.tsx:746`)
- When counting `waiting` chip, exclude sessions with `acknowledged === true`.

**DetailPanel** (`packages/client/src/components/DetailPanel.tsx:586-638`)
- StateBadge: add "ACK" / "Un-ack" button.

---

### Acceptance Criteria

**Server**
- [ ] `acknowledged` field present on snapshot.
- [ ] `POST /api/sessions/:id/ack` toggles the flag and broadcasts.
- [ ] User input resets `acknowledged` the same way it resets `completionHint`.
- [ ] `/clear` resets `acknowledged`.
- [ ] Value survives session close → resume via `taskStorage`.

**Client**
- [ ] Worker tile shows no bubble when `acknowledged && waiting && !done && !needsPermission`.
- [ ] Room collapsed view: acknowledged sessions excluded from waiting count.
- [ ] Worker menu exposes ACK / Un-ack.
- [ ] DetailPanel StateBadge exposes ACK / Un-ack.
- [ ] DONE visually overrides ACK when both set.

**Performance**
- [ ] No extra broadcast beyond the existing snapshot path.

---

### Out of scope

- AI auto-ACK detection.
- Slash command `/ack`.
- Keyboard shortcut.
- Room-level bulk ack.
- Changes to `transcriptReader.ts` state machine.

### Open questions

1. Name: **ACK** or **OK**? Suggest: ACK.
2. Clear on any waiting→other transition? Suggest: yes, same path as `completionHint`.
3. Any visual on the worker when acknowledged? Suggest: fully hide the bubble.
4. One toggle endpoint or ack/unack split? Suggest: toggle.
