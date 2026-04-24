# Lineage-Scoped Fields — Single Source of Truth

Historical context: `color` drifted between three stores (`Session.color`, `OverlordSession.color`, `data/colors.json`). The snapshot builder re-derived on every build as a band-aid. Separate investigation found that concurrent resumes duplicated lineages because `pendingResumes` was cwd-keyed and consumed once.

## Canonical Locations

| Field             | Canonical store                                                | Notes                                                                 |
|-------------------|----------------------------------------------------------------|-----------------------------------------------------------------------|
| `color`           | `OverlordSession.color`                                        | `setSessionColor` patches via `sessionStore.patch`. No secondary map. |
| `proposedName`    | `OverlordSession.proposedName`                                 | `setSessionName` uses `sessionStore.patch`. Historical dup in `known-sessions.json` reconciled on boot. |
| `intent`          | `OverlordSession.intent`                                       | Written by intent summarizer only.                                    |
| `sessionType`     | `OverlordSession.sessionType`                                  | Inherited on resume.                                                  |
| `gitBranch`       | `OverlordSession.gitBranch`                                    | Live `Session.gitBranch` copied from here each snapshot.              |
| `provider`        | `OverlordSession.provider`                                     |                                                                       |
| `lastActivity`    | **transcript file mtime** — NOT `OverlordSession.lastActivity` | The field on OverlordSession is seed-once. Do not use it as freshness. |

Instance-scoped (per Claude process, not lineage): `sessionId`, `pid`, `startedAt`, `state`, `activityFeed`, `permissionMode`, `compactCount`, `isCompacting`, `slug`, `resumedFrom`, `model`, `inputTokens`, `transcriptPath`.

## Resume Lineage Linking

- `terminal:resume` spawns PTY with `claude --resume <sid> --name ___OVR:<ptyId>`.
- Server calls `stateManager.trackPendingResumeByMarker(ptyId, resumeSessionId)` **before** spawn. cwd-keyed `trackPendingResume` retained as fallback only.
- In `addOrUpdate`, marker-keyed lookup runs first. Consumed on use; each spawn finds its own parent even when many resumes fire in the same cwd within seconds.
- Without this, concurrent resumes produced multiple lineages (observed: 6 live `claude --resume` processes for one Lysander session — DetailPanel auto-resume on `onFocus` turned a visual refresh into a spawn loop).

## Boot & Purge

- `hydrateAllActiveSessions()` iterates `sessionStore.listActive()` and rehydrates each record as a closed worker. Rooms that were previously invisible on boot (sessions lazy-loaded only on interaction) now render immediately.
- `getSnapshot()` surfaces rooms from `~/.claude/overlord/rooms/*.config.json` via `listConfiguredRoomSlugs()` + reverse slug lookup through `sessionStore.listAll()`. User can spawn a fresh session in an empty room.
- `purgeStaleOverlordSessionFiles()` freshness signal = newest transcript mtime across `lineage.history[].transcriptPath` (falling back to `findTranscriptPath`/`findTranscriptPathAnywhere`). Records are deleted only if:
  1. `overlordId` is not in `this.sessions` (hydrated view), AND
  2. Every transcript is missing OR the newest transcript is older than `maxAgeMs` (default 2d).
- Scheduled 30s after boot and every 24h (see `index.ts`).

## Forbidden Patterns

- CWD-keyed single-shot pending maps for resume/clear/spawn tracking. Always use the name marker embedded in `--name` (or the raw sessionId if known).
- Reading `OverlordSession.lastActivity` to decide if a record is stale. Use transcript mtime.
- Adding a second in-memory cache for a lineage field that already lives on `OverlordSession`. If snapshots drift, patch the read path, not a shadow store.
