# "Queued" Badge Stuck on Long Sessions

**Area:** Message injection — client state
**Status:** Fixed

## Symptoms

- User sends a message. It reaches Claude and appears in the transcript — but the client keeps showing it as "queued" until the 60 s timeout.
- Duplicated rendering: the same message appears both as a confirmed transcript entry **and** as a stale queued entry.
- Only happens on **long** sessions — fresh sessions clear the queued state immediately.

## Root Cause

Two compounding bugs around how the client confirms that a queued message was delivered.

### 1. Feed is capped — count-based confirmation breaks

`transcriptReader.ts` caps `activityFeed` at `MAX_FEED_MESSAGES = 100`. On long sessions, every new user message pushes an old one off the front. The old "count user messages in the feed" confirmation logic compared `currentUserCount` against `realCountAtFirstSend` — but the count stayed flat (add one new, drop one old), so the confirmation check never triggered.

### 2. Oldest-first feed searched with `.find()`

`activityFeed` is built oldest-first. The timestamp-fallback fix used `realFeed.find(i => i.role === 'user')` to look up "the latest user message" — but `.find()` returns the **first** match, i.e. the **oldest** user message in the buffer. Its timestamp was always older than `sendTimestampMs.current`, so the check kept failing and the badge kept showing.

## Fix

### Per-session send timestamp

`DetailPanel.tsx` tracks `sendTimestampMs` per session (ref map, saved/restored on session switch). When `handleSend` fires, it stamps `Date.now()` into the current session's entry.

### Newest-user-message lookup

Confirmation logic now reverses the feed before searching:

```ts
const newestUserTs = [...realFeed].reverse().find(i => i.role === 'user')?.timestamp;
const newestUserTsMs = newestUserTs ? new Date(newestUserTs).getTime() : 0;
const confirmed =
  currentUserCount > prevUserCount ||
  (sendTimestampMs.current !== null && newestUserTsMs >= sendTimestampMs.current);
```

Either signal — count increased **or** the newest user message is timestamped at/after the send — clears the queued entry. The same fix applies in the session-switch `alreadyConfirmed` check.

## Where to Look If It Regresses

- `packages/client/src/components/DetailPanel.tsx` — `sendTimestampMs` ref, `sendTsPerSession` map, and both confirmation sites.
- `packages/server/src/session/transcriptReader.ts` — `MAX_FEED_MESSAGES`. If this is raised, the count-based path is more reliable but the timestamp path is still the correct fallback.
- Verify `activityFeed` ordering — this fix assumes oldest-first. If the feed is ever flipped to newest-first, the `.reverse()` must go.
