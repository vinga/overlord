# Compacting Detection Missing or Delayed

**Area:** PTY output parsing / transcript reader  
**Status:** Fixed

## Symptoms

- The "Compacting conversation" state indicator does not appear, or appears only sometimes.
- Looking at the raw PTY output in the terminal shows the compacting message was printed, but Overlord missed it.
- Appears intermittently — works on one session, misses on another.

## Root Cause

Two independent bugs:

### Bug 1 — PTY output split across chunks

`ptyEvents.ts` detected compacting by checking if a single PTY data chunk contained the string `"Compacting conversation"`. PTY output is delivered in variable-sized chunks by the OS — there is no guarantee a multi-word phrase lands in one chunk. The string could be split across two consecutive writes, causing the match to fail.

### Bug 2 — Transcript shrink not resetting incremental scan

`transcriptReader.ts` uses an incremental scan cache (`cached.fileSize`) to avoid re-reading the entire transcript on every poll. When Claude's `/clear` command runs, the transcript is replaced with a new (smaller) file. The cache still held the old `fileSize`, so `scanFrom = cached.fileSize` pointed past the end of the new file — the scanner read nothing and compaction events were silently skipped.

## Fix

### Fix 1 — Rolling buffer in ptyEvents

A per-session rolling text buffer (`compactDetectBuf`, max 500 chars) accumulates recent PTY output. Pattern matching runs on the buffer, not individual chunks. The buffer is cleared on repaint sequences (which signal a fresh screen) and on PTY exit.

```ts
const compactDetectBuf = new Map<string, string>();
const COMPACT_DETECT_BUF_SIZE = 500;
```

Implemented in `packages/server/src/pty/ptyEvents.ts`.

### Fix 2 — Reset scan offset when file shrinks

```ts
const fileShrank = cached && fileSize < cached.fileSize;
let compactCount = fileShrank ? 0 : (cached?.compactCount ?? 0);
let lastCompactTimestamp = fileShrank ? undefined : cached?.lastCompactTimestamp;
const scanFrom = fileShrank ? 0 : (cached?.fileSize ?? 0);
```

Implemented in `packages/server/src/session/transcriptReader.ts`, `detectCompactionIncremental`.

## Where to Look If It Regresses

- `ptyEvents.ts` — check `compactDetectBuf` logic and that the buffer is cleared on repaint.
- `transcriptReader.ts` — check `fileShrank` reset logic in `detectCompactionIncremental`.
- Server logs: `[compact]` entries when detection fires; absence of these for a known compaction means the PTY path missed it.
- The PTY path fires first (real-time); the transcript path is a delayed fallback. If PTY detection is broken, compacting may still appear after the next transcript poll cycle (~3–8 s late).
