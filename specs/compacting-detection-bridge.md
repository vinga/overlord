## Spec: Compacting Detection for Bridge Sessions

**Goal:** When `/compact` runs in a bridge session, the Conversation tab shows the "Compacting conversation…" state (matching today's PTY-session behavior).

**Inputs / Triggers:** Live stdout stream of a bridge session containing the string `Compacting conversation` (possibly split across chunks, possibly preceded by ANSI sequences and a spinner glyph).

**Outputs / Side effects:**
- `session.isCompacting` flips to `true`.
- An `ActivityItem` with `kind:'compact'` and `content` = the matched line (e.g. `Compacting conversation… (54s · ↑ 12.5k tokens · esc to interrupt)`) is prepended to `session.activityFeed`.
- `session.ptyCompactBaseline` is snapshotted so `isCompacting` stays sticky until a real `compact_boundary` lands in the transcript.
- The change is broadcast to clients via the normal snapshot path.

**Acceptance Criteria:**
- [ ] Running `/compact` in a bridge session (Morion-style) makes the Conversation tab's state bar read "Compacting conversation…" within ~1 second of the spinner appearing in the terminal.
- [ ] A compact divider (`✦ Compacted · <pty meta>`) appears in the Conversation feed for that bridge session, sourced from the live PTY line.
- [ ] PTY-session behavior is unchanged — same detection still fires for PTY terminals.
- [ ] Detection is tolerant of chunk splits (rolling buffer, same size/clearing rules as PTY path).
- [ ] Detection is tolerant of ANSI / OSC / spinner glyphs in the stream (strip before matching, matching today's PTY path).
- [ ] After a real `compact_boundary` lands in the transcript, `isCompacting` clears (sticky baseline released).
- [ ] No duplicate compact items on the same spinner frame sequence — buffer is cleared after a match, same as PTY.

**Design:**
- Extract the shared detector into a module — e.g. `packages/server/src/pty/compactDetect.ts` — exporting a function like `feedCompactDetector(sessionKey: string, chunk: string | Buffer, onDetect: (line: string) => void): void` plus a `clearCompactDetector(sessionKey)` hook.
- Reuse from `ptyEvents.ts` (keyed by `ptySessionId`, cleared on repaint + exit).
- Call from `index.ts`'s `bridgeManager.on('output')` (keyed by bridge `sessionId`, cleared on bridge `disconnected` / `output socket error` / session close).
- Both call sites resolve `ovrId` and invoke `stateManager.addPtyCompact(ovrId, line)`.

**Out of scope:**
- Changing the transcript-reader fallback path (`detectCompactionIncremental`).
- UI changes to how "Compacted" / "Compacting" renders.
- Adding a live countdown/progress UI beyond what `addPtyCompact` + existing state bar already show.
- Bridge PTY repaint-based clearing. Bridge output does not emit `\x1b[?2026h` synchronous-update markers; buffer clearing relies on detection-match reset and session-lifecycle hooks.

**Open questions:**
- Should the bridge-side buffer also reset on any ANSI "clear screen" sequence (`\x1b[2J` / `\x1b[3J`), or is match-based clearing sufficient? (Proposed: match-based only, matching PTY simplicity.)
