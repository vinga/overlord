# Bridge Session Name Duplication (`___BRG:xxx___BRG:yyy`)

**Area:** Bridge — session naming  
**Status:** Fixed

## Symptoms

- Opening a bridge terminal (via "Open in Terminal" or "Open Bridged") creates a Claude command with a doubled marker in the `--name` flag.
- Example: `--name "Felix___BRG:old-id___BRG:new-id"` instead of `--name "Felix___BRG:new-id"`.
- Results in a session whose `proposedName` contains two `___BRG:` segments, which can confuse bridge linking on subsequent opens.

## Root Cause

`proposedName` on the session already contained a `___BRG:` marker from the previous bridge link. When constructing the new command, the marker was appended again without stripping the old one first.

## Fix

`stripInternalMarkers()` helper in `wsHandler.ts` strips all `___BRG:xxx` and `___OVR:xxx` suffixes before constructing `sessionName` for both `terminal:open-external` and `terminal:open-bridged` handlers.

```typescript
function stripInternalMarkers(name: string): string {
  return name.replace(/___(?:BRG|OVR):[A-Za-z0-9_-]*/g, '').replace(/[-_\s]+$/, '').trim();
}
```

**File changed:** `packages/server/src/api/wsHandler.ts`

## Where to Look If It Regresses

- `wsHandler.ts` — `terminal:open-external` and `terminal:open-bridged` handlers. Verify `stripInternalMarkers` is called on `proposedName` before appending a new marker.
- Check the resulting `--name` flag in the spawned Terminal.app command. It should contain exactly one `___BRG:` segment.
