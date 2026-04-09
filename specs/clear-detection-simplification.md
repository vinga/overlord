## Spec: Unified /clear Detection

**Goal:** Replace 6+ scattered /clear detection mechanisms with one simple, reliable approach.

**Problem today:** /clear detection is spread across `sessionEventHandlers.ts` (PID-based, CWD-based), `transcriptWatcher.ts` (pending clear, transcript content scan, startup orphan scan), and `index.ts` (bridge marker matching). These overlap, race, and create cascading bugs — especially on server restart where old orphan transcripts trigger false replacements.

---

### What Claude does during /clear

1. Creates a new transcript `.jsonl` with a new sessionId
2. Updates `{pid}.json` **in-place** with the new sessionId (same PID, same filename)
3. The new transcript's first lines contain `<command-name>/clear</command-name>`

**Key invariant:** PID stays the same. Session file updates in-place.

---

### Proposed approach: PID-based detection only

Since the session file always updates with the new sessionId, detection is trivial:

1. **Session file changes** → `sessionWatcher` fires `changed` event
2. **PID matches existing session with different sessionId** → it's a /clear (or resume)
3. **Transfer name/color/pipe/order** from old to new
4. **Mark old as replaced** (not deleted — keep for history)

This is already implemented as path #1 in `sessionEventHandlers.ts` `changed` handler (lines 262-280). It's the most reliable path. All other paths exist because this one sometimes misses — but the fix should be making this one always work, not adding fallbacks.

---

### When PID-based detection fails

The only case where PID-based detection fails is:

- **Server was down during /clear** — the session file already has the new sessionId when the server starts. There's no `changed` event because the server didn't see the transition.

Fix: On startup, after loading known-sessions and detecting all live session files, compare each known session's stored sessionId with the session file's current sessionId. If they differ and the PID is the same → /clear happened while server was down.

```
for each knownSession:
  sessionFile = readSessionFile(knownSession.pid)
  if sessionFile.sessionId !== knownSession.sessionId:
    // /clear happened while we were down
    transferState(knownSession.sessionId → sessionFile.sessionId)
```

This replaces: startup orphan scan, bridge marker suffix matching, handleTranscriptAdded /clear content detection.

---

### What to keep

- **`transferSessionState()`** — the atomic state transfer function. Already works well.
- **PID-based detection in `changed` handler** — the primary live detection path.
- **Pending clear mechanism** — for UI-injected /clear (we know the exact session, no guessing needed).

### What to remove

- **Startup orphan scan** (`transcriptWatcher.ts` setTimeout 3s) — replaced by PID file comparison on startup
- **Transcript content /clear detection** (`handleTranscriptAdded` lines 134-190) — unreliable CWD matching
- **Bridge marker suffix matching** in `linkPendingBridge` (`index.ts` lines 433-453) — fragile, caused cascading bugs
- **CWD-based recent removal fallback** (`sessionEventHandlers.ts` lines 243-255) — ambiguous in shared CWDs
- **`serverStartTime` guard** — no longer needed if we don't scan transcripts for /clear

### What to simplify

- **`linkPendingBridge`** — should only handle initial bridge linking (pending entry or `overlord-${marker}` convention). No marker suffix matching, no registry scanning, no state transfers. If the session already has `bridgePipeName` from known-sessions, use it directly.
- **`reconnectBridgePipes`** — just iterate known bridge sessions and connect. No closed-session skipping needed because the startup PID comparison already corrected sessionIds.

---

### Acceptance Criteria

- [x] /clear during normal operation detected via session file `changed` event (existing behavior, unchanged)
- [x] /clear while server was down detected on startup via PID file comparison
- [x] Name, color, bridge pipe, PTY session, room order transferred to new session
- [x] Old session marked with `replacedBy`, removed from active view
- [x] No CWD-based matching anywhere in /clear detection
- [x] No transcript content scanning for /clear detection
- [x] Bridge sessions survive server restart with correct pipe name
- [ ] Multiple /clear chains (A → B → C) work correctly
- [x] Multiple sessions in same CWD don't interfere with each other

### Out of scope

- Changing how Claude handles /clear (session file format, etc.)
- UI changes for /clear indication
- Resume (`--resume`) detection — separate mechanism, already works

### Open questions

- Should we keep the pending clear mechanism for UI-injected /clear, or can PID-based detection handle that too? (Likely keep — it's fast and unambiguous)
- Should `replacedBy` chain be limited in depth? (Probably not — just skip closed/replaced sessions in UI)
