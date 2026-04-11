# CWD-Based Session Matching Causes Bugs

**Area:** Session lifecycle — /clear detection, bridge linking  
**Status:** Documented (removed from codebase)

## Symptoms

- Sessions get linked to the wrong worker after `/clear`.
- A new bridge session replaces the wrong existing session.
- Two sessions sharing the same `cwd` intermittently swap state, names, or colors.
- Hard-to-reproduce, often only manifests when multiple sessions are open in the same directory.

## Root Cause

Multiple Claude sessions routinely share the same working directory (`cwd`) — e.g. two sessions in the same project, or a parent + subagent. Any code that matches sessions by `cwd` alone will non-deterministically pick the wrong one.

CWD-based mechanisms that were removed because of this:

| Mechanism | Where it was | Why removed |
|-----------|-------------|-------------|
| `recentlyRemovedByCwd` fallback | `sessionEventHandlers.ts` `added` handler | Matched new sessions to the wrong removed session when multiple shared a cwd |
| Transcript content `/clear` detection + CWD match | `transcriptWatcher.ts` | False positives; raced with PID-based detection |
| Startup orphan scan | `index.ts` 3s setTimeout | Scanned by slug/cwd, replaced wrong sessions on startup |
| Bridge marker suffix matching | `linkPendingBridge` | Used cwd-derived slugs as fallback, linked to wrong pipe |

## Fix

All session matching uses unique identifiers only:

- **Name markers** embedded in `--name` flags (`___OVR:ptyId`, `___BRG:marker`) for deterministic PTY and bridge linking.
- **PID matching** when the spawner knows the child PID.
- **SessionId matching** (`pendingPtyByResumeId`) when the target sessionId is known upfront.
- **`/clear` detection** uses only 3 PID-based paths — see `session-cleanups.md` in the diagnose-sessions skill and `specs/clear-detection-simplification.md`.

## Rule

**Never use CWD for session matching.** This is documented in `CLAUDE.md` under "Session Matching Rules". If a new mechanism tempts CWD matching (e.g. "find sessions in this workspace"), stop and find a unique identifier instead.

## Where to Look If It Regresses

- `sessionEventHandlers.ts` — `added` handler. Must not contain any `cwd`-based lookup.
- `index.ts` — `linkPendingBridge`. Must match only by marker, not by pipe-name prefix or cwd slug.
- `stateManager.ts` — no `findSessionByCwd` method should exist.
- Server logs: if two sessions swap names or a bridge links to the wrong session, suspect a CWD-based fallback was re-added.
