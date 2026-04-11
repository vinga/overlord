# Pending Messages Disappear on Session Switch

**Area:** Message injection — client optimistic state  
**Status:** Fixed

## Symptoms

- A message is sent and shows a "pending" badge in the conversation feed.
- User switches to another session and back.
- The pending message is gone — even though it may still be in-flight or unconfirmed.

## Root Cause

`localSent` (the array of optimistic/pending messages) was reset to `[]` every time `selectedSession` changed in the session-switch `useEffect` in `DetailPanel.tsx`. Switching sessions wiped pending state for the previous session.

## Fix

`localSent` and `realCountAtFirstSend` are now stored per-session using `localSentPerSession` and `realCountPerSession` refs (both `Map<sessionId, ...>`). On session switch, pending state is saved for the old session and restored for the new one. When messages are confirmed or timed out, the per-session maps are cleaned up.

**Files changed:**
- `packages/client/src/components/DetailPanel.tsx` — added `localSentPerSession` and `realCountPerSession` refs; session-switch effect saves/restores instead of clearing

## Background: How Optimistic Confirmation Works

- `localSent: string[]` — messages added client-side, shown as "pending"
- `realCountAtFirstSend` — snapshot of real user message count when the first pending message was sent
- **Confirmation:** when `currentUserCount > realCountAtFirstSend`, the server feed has caught up → `localSent` is cleared
- **Timeout:** 60s safety net clears stale pending messages

**What can block confirmation:**
- Injection failed silently (caught by boolean return — see `queued-messages-lost.md`)
- Session is compacting (`isCompacting` true)
- Bridge pipe is dead
- Transcript watcher missed the update (stale chokidar)

## Where to Look If It Regresses

- `DetailPanel.tsx` — session-switch `useEffect`: verify it saves/restores from `localSentPerSession` rather than resetting to `[]`.
