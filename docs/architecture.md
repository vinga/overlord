# Overlord — Architecture Overview

## System diagram

```
┌──────────────────────── FILESYSTEM (sources of truth) ────────────────────────┐
│                                                                               │
│  Claude CLI                     Overlord                                      │
│  ───────────                    ────────                                      │
│  ~/.claude/                     ~/.claude/overlord/                           │
│   projects/{slug}/               overlord-sessions/{ovrId}.json               │
│     {sid}.jsonl  (transcript)      (active — one OverlordSession per ovrId)   │
│     {sid}/agent-*.jsonl          overlord-sessions-archive/{ovrId}.json       │
│   sessions/{pid}.json              (archived — same shape, moved on archive)  │
│                                  archive/{slug}/{ovrId}/{sid}.jsonl           │
│                                    (transcript copies, one per lineage entry) │
│                                  known-sessions.json  (stateManager cache)    │
│                                  deleted-sessions.json                        │
│                                  pending-resumes.json                         │
│                                  .migration-v2-done   (one-shot marker)       │
│                                  .legacy-backup/{stamp}/                      │
│                                    (intent-summaries, rooms/, tasks/,         │
│                                     notes.json, archive/index.json — frozen)  │
└───────────────────────────────────────────────────────────────────────────────┘
           ▲                                ▲
    chokidar watch                  SessionStore R/W
           │                                │
┌──────────┼────────────────────────────────┼───────────────────────────────────┐
│          │   SERVER PROCESS (Node)        │                                   │
│  ┌───────┴──────┐      ┌──────────────────┴──────────────────┐                │
│  │ SessionWatch │──┐   │ SessionStore                        │                │
│  │ (pid .json)  │  │   │  active:   Map<ovrId, OverlordSes>  │                │
│  └──────────────┘  │   │  archived: Map<ovrId, OverlordSes>  │                │
│  ┌──────────────┐  │   │  sidIndex: Map<sid,   ovrId>        │                │
│  │TranscriptWat.│──┤   │  atomic tmp+rename, debounced flush │                │
│  │ (jsonl tail) │  │   │  per-overlord Promise chain         │                │
│  └──────────────┘  │   └──┬─────────────────────────────────┬┘                │
│  ┌──────────────┐  │      │ upsertActive / patch /          │                 │
│  │ ProcessCheck │──┤      │ getByOverlordId / getBySessionId│                 │
│  │  (PID poll)  │  │      │ attachSession (lineage append)  │                 │
│  └──────────────┘  │      │ archive / unarchive (file move) │                 │
│                    │      │ ensureFromLive / removeBySessionId                │
│                    │      │                                 │                 │
│                    │      ├─── intentSummary.ts  (Haiku intent per ovrId)     │
│                    │      ├─── taskStorage.ts    (plan/current/summaries)     │
│                    │      ├─── archiveManager.ts (copies transcripts, archive)│
│                    │      └─── apiRoutes.ts      (/api/notes, /api/archive)   │
│                    ▼                                                          │
│          ┌──────────────────────┐                                             │
│          │    StateManager      │  sessions: Map<sid, Session>  (runtime)     │
│          │  (central in-memory) │  ensureFromLive ──► SessionStore            │
│          └──────────┬───────────┘  getSnapshot: LiveSession ⊕ OverlordSession │
│                     │                                                         │
│                     │ onChange → getSnapshot() ──────────► broadcast          │
│                     │                                                         │
│  ┌──────────────────┼─────────────────┐                                       │
│  │  PTY subsystem   │   Bridge        │     AI subsystem                      │
│  │  ptyManager      │   bridgeManager │     aiClassifier, IntentSummarizer    │
│  │  injectScheduler │   pipeInjector  │     runClaudeQuery (Haiku)            │
│  └──────────────────┴─────────────────┘                                       │
│                     │                                                         │
└─────────────────────┼─────────────────────────────────────────────────────────┘
                      │ WebSocket (OfficeSnapshot)
                      ▼
┌─────────────────────────────────────── CLIENT (React) ────────────────────────┐
│  useOfficeData  ──►  Office / Room / Worker / DetailPanel / BrainTab          │
│  Room groups sessions by cwd.                                                 │
│  Worker = one Session bubble.  Subagents = smaller dots near their parent.    │
│  DetailPanel = chat UI, activity feed, embedded terminal (via useTerminal).   │
│  Archive list in Room shows intent (italic), lastMessage, notes (amber).      │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Entity model

```
OverlordSession (persisted — one file per overlordId)
 ├── overlordId, cwd, startedAt, color, proposedName
 ├── provider, sessionType, model, slug
 ├── lineage                    ← atomic: currentSessionId + history[]
 │     currentSessionId
 │     history[]: { sessionId, attachedAt, transcriptPath?, reason? }
 │       reason = initial | clear | compact | resume
 ├── intent, intentTurnCount, intentUpdatedAt
 ├── notes
 ├── currentTask, planTasks[], completionSummaries[]
 ├── completionHint ('done'?), acknowledged
 ├── lastMessage, lastActivity
 └── archive?                   ← presence = archived
       archivedAt, roomId, name
       gitBranch?, pullRequest?
       transcripts[]: { sessionId, path }   (one per lineage entry)

LiveSession (runtime only — never persisted)
  pid, state (working|thinking|waiting|closed)
  activityFeed[], subagents[], ptyCompactItems[]
  inputTokens, compactCount, isCompacting
  permissionMode, needsPermission, pendingQuestion
  bridgeTty, bridgeDead, ptySessionId, ptyInputPendingSince
  loadedAt, staleCount, isWorker

Session (broadcast wire type) = LiveSession ⊕ durable fields from OverlordSession
  Composed at StateManager.getSnapshot() time — one row per current sessionId.

Task  (lives inline on OverlordSession, not its own file)
  taskId, sessionId, state (active|done), kind (task|plan), title, summary
  planContent, planToolUseId, planStatus, accepted, createdAt, completedAt

Room (derived)  { id, name, cwd, sessions[], gitBranch?, pullRequest? }
  Built from StateManager.getSnapshot() by grouping sessions by cwd.

Subagent  { agentId, agentType, description, state, lastActivity, activityFeed[] }
  Transcript-derived (agent-*.jsonl); surfaced as smaller worker dots.

ActivityItem  kind = message | tool | thinking | compact
  Transcript-derived; rendered in DetailPanel and activityFeed.
```

## Identity & lineage

```
overlordId  = stable Overlord-owned identity (never changes)
sessionId   = Claude Code UUID (changes on /clear, /compact, --resume)

One overlordId can own many sessionIds over its lifetime. sidIndex maps any
sessionId the server has seen to the owning overlordId, so callers that only
know a Claude UUID can always find the durable record.

            ┌─────────────────────────── OverlordSession ovr-abc ────────┐
            │ lineage.history:                                           │
/clear      │   { sid-1, t=1000, reason='initial'  }                     │
/compact    │   { sid-2, t=1500, reason='clear'    }                     │
--resume    │   { sid-3, t=2100, reason='compact'  }                     │
            │   { sid-4, t=2800, reason='resume'   }  ← currentSessionId │
            └────────────────────────────────────────────────────────────┘
              sidIndex: sid-1 → ovr-abc
                        sid-2 → ovr-abc
                        sid-3 → ovr-abc
                        sid-4 → ovr-abc
```

## Session lifecycle

```
spawn/detect ──► sessionWatcher → addOrUpdate() ──► StateManager
                                           │                │
                                           │                └─ ensureFromLive
                                           ▼                     │
                                   transcriptWatcher polls       ▼
                                           │              SessionStore
                  ┌────────────────────────┼──────────────────────┐
                  ▼                        ▼                      ▼
              intent refresh          task/plan events       permission events
        (IntentSummarizer.patch  (taskStorage.patch    (LiveSession flags only —
         BySessionId)             BySessionId)          not persisted)
                  │                        │
                  └── all durable writes resolve sessionId → overlordId,
                      then land on the OverlordSession record.

/clear or /compact detected:
  StateManager.transferSessionState(oldSid, newSid, reason)
    └─► sessionStore.attachSession(ovrId, { sessionId: newSid, reason })
          appends to lineage.history, swaps currentSessionId, updates sidIndex

archive:
  archiveManager.archive()
    ├─► copies each lineage-history transcript → archive/{slug}/{ovrId}/{sid}.jsonl
    └─► sessionStore.archive(ovrId, snapshot)
          moves overlord-sessions/{ovrId}.json → overlord-sessions-archive/{ovrId}.json
          sets archive block with transcripts[]

unarchive:
  sessionStore.unarchive(ovrId)  — inverse move, clears archive block
  archived transcript files deleted from archive/{slug}/{ovrId}/

delete:
  deleteSession(sid) ─► kill pid, rm files, stateManager.remove(),
                        sessionStore.removeBySessionId(sid)
                          resolves sid → ovrId, deletes file, clears indexes
```

## Notes

- **SessionStore** is the sole durable-writer for per-overlord state. Atomic
  tmp+rename, debounced flush, per-overlord Promise chain for serial writes.
- **Archived records** live in a separate directory so `listActive()` /
  `listArchived()` are O(Map) lookups without filtering.
- **StateManager** remains the in-memory hub for runtime fields and broadcast.
  `known-sessions.json` is still written as a startup-hydration cache
  (a Phase-3-leftover dual-write, not on the SessionStore write path).
- **Migration** was a one-shot on first boot (marker `.migration-v2-done`);
  the module itself and its test were removed in Phase 4. Legacy files are
  preserved under `.legacy-backup/{stamp}/` for rollback.
- **Session matching** uses name markers, PID, and sessionId — **never CWD**
  (see CLAUDE.md).
- **/clear detection** uses only PID-based mechanisms (live file changes,
  stale transcript poll, startup PID compare, UI-injected clears).
