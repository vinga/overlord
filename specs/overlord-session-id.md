# Spec: Overlord Session ID (ovrId)

## Goal

Introduce a stable `overlordId` per "worker" that persists across Claude UUID transitions
(from `/clear`, compaction, resume) and PTY restarts. This eliminates the `migratePtyMaps`
complexity and fixes the entire class of "conversation and terminal are out of sync" bugs —
including the compaction-during-resume bug that triggered this spec.

---

## Problem Statement

Claude session IDs (UUIDs) and PTY session IDs (`pty-xxx`) are both transient:

- **Claude UUID** changes on: `/clear`, auto-compaction, `--resume` creating a new UUID
- **PTY session ID** changes on: PTY restart, reconnect after server restart

The current system bridges them via `claudeToPtyId` / `ptyToClaudeId` maps that must be
surgically migrated on every identity transition. Every new edge case (compaction during
resume, /clear in a bridge session, reconnect after crash) requires a new patch.

**Root cause of the Manawyd bug:**
1. `terminal:resume 1a9b865b` spawns PTY with `--resume 1a9b865b --name ___OVR:ptyId`
2. PTY links to 1a9b865b via marker → `ptyToClaudeId[ptyId] = 1a9b865b`
3. Compaction fires → new session Z appears (same PID, no `___OVR:` marker)
4. `/clear detection` skipped because `hasActiveResumeInProgress() = true`
5. Z links to PTY via `pendingPtyByPid` (PID still available) → `ptyToClaudeId[ptyId] = Z`
6. Both 1a9b865b and Z reference the same PTY. Output goes to Z; conversation UI
   shows 1a9b865b. They diverge.

---

## Solution: ovrId as Stable Identity

```
ovrId  (stable — lives as long as the "worker" concept)
  ├── claudeSessionId  → changes on /clear, compaction
  └── ptySessionId     → changes on PTY restart / reconnect
```

The `ovrId` is assigned once per "worker lineage" and is inherited by any session that
replaces another. PTY routing uses `ovrId` as the primary key. The client uses `ovrId`
as the terminal key — it never needs to re-link the terminal when the Claude UUID changes.

---

## Architecture

### New Maps (server, `index.ts`)

```typescript
// Replace claudeToPtyId / ptyToClaudeId with these three:
const ovrToPty    = new Map<string, string>();  // ovrId  → ptySessionId
const ptyToOvr    = new Map<string, string>();  // ptySessionId → ovrId
// claudeToOvr lives inside StateManager (stateManager knows all sessions)
```

`ovrToClaude` is not a map — it's derived via `stateManager.getSession()` which has
`session.overlordId` indexed by claudeId. Use `stateManager.getActiveClaudeByOvr(ovrId)`.

### SessionState (types.ts)

```typescript
interface Session {
  overlordId: string;   // ADD: stable identifier, assigned on first creation
  sessionId: string;    // Claude UUID (unchanged)
  // ...rest unchanged
}
```

### StateManager additions

```typescript
// New internal index
private sessionsByOvrId = new Map<string, string>(); // ovrId → claudeSessionId

// New methods
getActiveClaudeByOvr(ovrId: string): Session | undefined
generateOvrId(): string   // "ovr-" + 8 random chars
assignOvrId(sessionId: string, ovrId: string): void  // for linking known ovrId to new session
```

**In `addOrUpdate`:** If the session is new (not in `sessions` map), generate `ovrId`.
Populate `sessionsByOvrId[ovrId] = sessionId`.

**In `transferSessionState(oldId, newId)`:** Copy `overlordId` from old to new session.
Update `sessionsByOvrId`: delete old entry, add new `ovrId → newId`.
This is the ONLY place ovrId migration is needed — because all PTY/bridge routing uses
ovrId, no map migration is required elsewhere.

---

## Linking Flow

### PTY spawn (new session)

1. `terminal:spawn` → PTY spawns with `--name ___OVR:ptyId`
2. Session appears with `___OVR:ptyId` in name → ovrId from `session.overlordId`
3. `ovrToPty[ovrId] = ptyId`, `ptyToOvr[ptyId] = ovrId`
4. Broadcast: `{ type: 'terminal:linked', ovrId, ptySessionId, claudeSessionId }`

### PTY resume

1. `terminal:resume X` → PTY spawns with `--resume X --name ___OVR:ptyId`
2. Session appears (could be X or a new UUID if compaction fires immediately)
   - If it's X: link by marker → ovrId = X's `overlordId`
   - If it's Z (compaction replacement): `transferSessionState(X, Z)` → Z inherits ovrId
3. `ovrToPty[ovrId] = ptyId`, `ptyToOvr[ptyId] = ovrId`
4. PTY output: `ptyToOvr[ptyId]` → ovrId → broadcast to client using ovrId

### Compaction / /clear (Claude UUID changes, same PTY)

1. New session Z appears (added event)
2. PID detection or marker detection identifies Z as a replacement for old session O
3. `transferSessionState(O, Z)` → Z inherits `overlordId` from O
4. `ovrToClaude` (inside stateManager) is updated automatically
5. `ovrToPty` does **not** change — PTY was already keyed by ovrId, still valid
6. Broadcast: `{ type: 'session:replaced', oldClaudeId: O, newClaudeId: Z, ovrId }`
7. Client: updates `claudeId` mapping but keeps terminal key as ovrId — **no terminal re-linking**

### PTY exit / reconnect

1. PTY exits → `ptyToOvr[ptyId]` → ovrId → broadcast `{ type: 'terminal:exit', sessionId: ovrId }`
2. Cleanup: `delete ovrToPty[ovrId]`, `delete ptyToOvr[ptyId]`
3. Buffer: `ptyOutputBuffer` migrates from ptyId → ovrId on exit (same as today, just keyed differently)
4. On reconnect / new PTY: new PTY links to same ovrId → client terminal continues

### /clear detection improvement (compaction-during-resume fix)

In `sessionEventHandlers.ts` `added` handler, when linking via `pendingPtyByPid`:

**Before** linking a new session Z to a PTY via `pendingPtyByPid`, check:
```typescript
const existingOvrId = ptyToOvr.get(entry.ptySessionId);
if (existingOvrId) {
  // PTY already has an ovrId — this is compaction/clear, not a new spawn
  // Transfer: Z inherits ovrId from the existing session
  const existingClaudeId = stateManager.getActiveClaudeByOvr(existingOvrId);
  stateManager.transferSessionState(existingClaudeId, Z.sessionId);
  // No PTY map changes needed — ovrToPty[ovrId] still points to same PTY
  broadcastRaw({ type: 'session:replaced', oldClaudeId: existingClaudeId, newClaudeId: Z.sessionId, ovrId: existingOvrId });
  closeOrRemoveReplaced(ctx, existingClaudeId);
  log('clear:detected', 'Compaction detected in PTY (ovrId path)', ...);
  return; // done
}
// Otherwise: normal new spawn, assign new ovrId
```

This eliminates the `hasActiveResumeInProgress()` guard problem — we don't need PID-based
/clear detection for this case anymore. The PTY's ovrId is the authority.

---

## WebSocket Messages

### Changed: `terminal:linked`

```typescript
// Before
{ type: 'terminal:linked', ptySessionId: string, claudeSessionId: string }

// After (adds ovrId, keeps others for backward-compat display)
{ type: 'terminal:linked', ovrId: string, ptySessionId: string, claudeSessionId: string }
```

### Changed: `terminal:output`, `terminal:exit`, `terminal:error`

```typescript
// sessionId changes from claudeSessionId → ovrId
{ type: 'terminal:output', sessionId: ovrId, data: string }
{ type: 'terminal:exit',   sessionId: ovrId, code: number }
{ type: 'terminal:error',  sessionId: ovrId, message: string }
```

### Changed: `session:replaced`

```typescript
// Adds ovrId so client can update its claude→ovr mapping without terminal re-link
{ type: 'session:replaced', oldSessionId: string, newSessionId: string, ovrId: string }
```

### Removed: `terminal:session-replaced`

No longer needed. The client uses `ovrId` as the terminal key; when the Claude UUID changes,
the client only needs to update the session metadata display, not the terminal connection.

### Snapshot

Each session in the snapshot gains `overlordId: string`. Client stores it alongside `sessionId`.

---

## Client Changes

### `types.ts`

Add `overlordId: string` to `Session`.
Update `TerminalLinkedMessage`, remove `TerminalSessionReplacedMessage`.

### `useTerminal.ts`

- `ptySessionIds: Set<ovrId>` — terminal key is now ovrId
- `outputHandlers`, `outputBuffer`, `exitHandlers`: keyed by ovrId
- `terminal:linked { ovrId }` → add ovrId to ptySessionIds (no migrateId needed)
- `terminal:output { sessionId: ovrId }` → route by ovrId directly
- `terminal:exit { sessionId: ovrId }` → exit handler by ovrId
- **Remove** `migrateId()` function — no longer needed
- **Remove** `terminal:session-replaced` handler
- Client→server messages (`terminal:input`, `terminal:inject`, `terminal:resize`, `terminal:kill`):
  send `sessionId: ovrId` — server resolves to current claudeId internally for bridge/inject routing

### `useOfficeData.ts`

`session:replaced` handler: no longer calls `onSessionReplaced` for terminal migration.
Only needed for room ordering (if applicable).

### `App.tsx` / `DetailPanel.tsx`

- Terminal presence check: `ptySessionIds.has(session.overlordId)` instead of `session.sessionId`
- When requesting terminal: send `ovrId` (or keep sending `claudeSessionId` — server resolves)

---

## Server: Input Routing Changes

In `wsHandler.ts`, all `claudeToPtyId.get(sessionId)` calls change to `ovrToPty.get(ovrId)`.

The `ovrId` for a given client request:
```typescript
// Client sends { sessionId: ovrId } for terminal messages
const ptyId = ovrToPty.get(msg.ovrId);
```

For bridge/inject: still need the Claude sessionId for `stateManager.isBridge(claudeId)`.
Resolve via `stateManager.getSession()` using `ovrId`:
```typescript
const session = stateManager.getActiveClaudeByOvr(ovrId);
const isBridge = stateManager.isBridge(session.sessionId);
```

---

## Migration: `migratePtyMaps` → removed

The `migratePtyMaps` function in `sessionEventHandlers.ts` is **deleted**. Its callers:
1. `/clear` by PID (added handler) → PTY routing unchanged; `transferSessionState` propagates ovrId
2. `/clear` by in-place file change (changed handler) → same
3. `transcriptWatcher.ts` pending-clear path → same
4. `transcriptWatcher.ts` stale transcript path → same

Each caller replaces `migratePtyMaps(ctx, old, new)` with:
```typescript
ctx.stateManager.transferSessionState(oldId, newId); // copies ovrId
ctx.broadcastRaw({ type: 'session:replaced', oldSessionId: old, newSessionId: new, ovrId: newSession.overlordId });
// No PTY map changes needed
```

---

## Logging Improvements

Add `[ovrId]` to all log events touching PTY or session linking:
```typescript
log('pty:linked', 'PTY linked', { sessionId: claudeId, sessionName: name, extra: `ovrId=${ovrId} ptyId=${ptyId}` });
log('clear:detected', 'Clear detected', { ..., extra: `ovrId=${ovrId} ${old}→${new}` });
```

Add debug REST endpoint (update `apiRoutes.ts`):
```
GET /debug/identity
Response: { 
  sessions: [{ claudeId, ovrId, ptyId, sessionType, name }],
  ovrToPty: Record<ovrId, ptyId>,
  ptyToOvr: Record<ptyId, ovrId>
}
```

---

## Acceptance Criteria

- [ ] Every session in the snapshot has `overlordId`
- [ ] `ovrId` is stable across `/clear` (new Claude UUID inherits ovrId)
- [ ] `ovrId` is stable across compaction (new Claude UUID inherits ovrId)
- [ ] After compaction-during-resume (Manawyd bug): conversation and terminal are in sync
- [ ] `terminal:output` uses `ovrId` as `sessionId`; client terminal renders correctly
- [ ] `terminal:linked` includes `ovrId`; client uses it as terminal key
- [ ] `terminal:session-replaced` is gone; clients don't need to re-link terminal on /clear
- [ ] `session:replaced` includes `ovrId`
- [ ] PTY exit cleans up `ovrToPty` and `ptyToOvr`; `terminal:exit` uses ovrId
- [ ] Bridge sessions work (ovrId applies equally to bridge and embedded)
- [ ] WS reconnect replay uses ovrId; terminal not blank after page refresh
- [ ] `terminal:kill` resolves ovrId → ptyId correctly
- [ ] `GET /debug/identity` returns full ovrId ↔ claudeId ↔ ptyId mapping
- [ ] `migratePtyMaps` function is deleted
- [ ] `terminal:session-replaced` message type is deleted

## Out of Scope

- Persisting `ovrId` across server restart (reconstructed from session scan on startup)
- Displaying `ovrId` in the UI
- Any changes to session JSON files on disk
- Session resume UI flow changes

## Files Touched

**Server:**
- `packages/server/src/types.ts` — add `overlordId` to `Session`
- `packages/server/src/session/stateManager.ts` — ovrId generation, `sessionsByOvrId` index, `transferSessionState`, `getActiveClaudeByOvr`
- `packages/server/src/session/sessionEventHandlers.ts` — remove `migratePtyMaps`, ovrId-aware linking
- `packages/server/src/session/transcriptWatcher.ts` — update 2 `migratePtyMaps` call sites
- `packages/server/src/pty/ptyEvents.ts` — `ptyToOvr` routing, output/exit keyed by ovrId
- `packages/server/src/api/wsHandler.ts` — `ovrToPty` for input/resize/kill/replay
- `packages/server/src/api/apiRoutes.ts` — debug endpoint
- `packages/server/src/index.ts` — map declarations, pass new maps to contexts

**Client:**
- `packages/client/src/types.ts` — add `overlordId`, update message types
- `packages/client/src/hooks/useTerminal.ts` — ovrId as terminal key, remove migrateId
- `packages/client/src/hooks/useOfficeData.ts` — session:replaced handler
- `packages/client/src/App.tsx` — terminal presence check
- `packages/client/src/components/DetailPanel.tsx` — terminal presence check
