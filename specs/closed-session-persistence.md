## Spec: Closed Session Persistence

**Goal:** Show sessions that ended before the server restarted by scanning existing transcripts on startup.

**Inputs / Triggers:**
- Server startup — `stateManager.loadClosedSessionsFromTranscripts()` is called once after initialization

**Outputs / Side effects:**
- All `.jsonl` transcript files under `~/.claude/projects/` that are not already tracked as active sessions are loaded as `state: 'closed'` entries in the `StateManager`
- A single `onChange()` broadcast is emitted after all closed sessions are loaded

**Acceptance Criteria:**
- [ ] On startup, closed sessions from previous runs appear in the `OfficeSnapshot` with `state: 'closed'`
- [ ] Sessions already tracked as active (live `sessionId` in state) are not duplicated
- [ ] `cwd` is read from the first line of each transcript; transcripts with no valid `cwd` are skipped
- [ ] Corrupt or unreadable transcript files are silently skipped; they do not crash the server
- [ ] Only top-level UUID `.jsonl` files are processed (subagent subdirectories are ignored)
- [ ] `pid` is set to `0` and `startedAt` to `0` for restored closed sessions (no live process)
- [ ] `lastActivity`, `lastMessage`, `activityFeed`, `model`, `inputTokens`, `compactCount` are populated from `readTranscriptState()`
- [ ] `proposedName` and `subagents` are populated from `readProposedName()` and `readSubagents()`

**Out of scope:**
- Writing per-session snapshot files to disk on close
- Pruning or expiring old transcript-based closed sessions
- Persisting sessions in states other than `'closed'`
