import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { PtyLinkageTracker } from './ptyLinkageTracker.js';
import { resolveResumableSessionId } from './transcriptReader.js';
import { restoreCanonicalFromShadow, SHADOW_ROOT_DIR } from './transcriptShadow.js';
import { buildOpencodeResumeArgs } from './opencodeSession.js';
import { sessionStore } from './sessionStore.js';
import type { LiveAtShutdownEntry } from './liveAtShutdownStore.js';

export interface AutoResumeDeps {
  stateManager: StateManager;
  ptyManager: PtyManager;
  ovrToPty: Map<string, string>;
  ptyToOvr: Map<string, string>;
  linkageTracker: PtyLinkageTracker;
  /** Sessions that had a live PTY at the previous shutdown, consumed once at
   *  boot. `null` = no capture (crash / kill -9) ⇒ resume nothing. */
  liveAtShutdown: LiveAtShutdownEntry[] | null;
}

/**
 * Re-spawn `claude --resume` for every embedded session that survived the
 * server restart. Triggered once on the first client WebSocket connection
 * (see wsHandler.ts) — not at boot, so the user's terminal output isn't lost
 * before they're connected to receive it.
 *
 * Per session:
 *  - opencode: spawn with provider-specific args, revive via stateManager
 *  - claude: resolve a resumable transcript (may fall back to ancestor sid),
 *    restore from shadow if needed, then spawn `claude --resume`. Reserve the
 *    lineage's existing ovrId against both marker and PID so the new sid
 *    re-joins the original OverlordSession instead of splitting off.
 */
export async function autoResumePtySessions(deps: AutoResumeDeps): Promise<void> {
  const { stateManager, ptyManager, ovrToPty, ptyToOvr, linkageTracker, liveAtShutdown: captured } = deps;
  // Only resume sessions that actually had a live PTY when the server shut
  // down — getPtySessionsToResume() returns every closed embedded session
  // ever, which would spawn a claude per stale card. The capture is written
  // by shutdown() and consumed once at boot; no capture (crash, kill -9,
  // pre-feature shutdown) means the live set is unknown, so resume nothing.
  if (captured === null) {
    console.log('[auto-resume] no shutdown capture found — skipping (only clean restarts auto-resume)');
    return;
  }
  const capturedSids = new Set(captured.map(e => e.sessionId));
  const capturedOvrs = new Set(captured.map(e => e.ovrId));
  const sessions = stateManager.getPtySessionsToResume().filter(({ sessionId }) =>
    capturedSids.has(sessionId) || capturedOvrs.has(sessionStore.resolveOverlordId(sessionId) ?? ''));
  if (sessions.length === 0) {
    console.log('[auto-resume] no live-at-shutdown sessions to resume');
    return;
  }
  console.log(`[auto-resume] resuming ${sessions.length} of ${captured.length} live-at-shutdown session(s)`);
  // Resume in parallel: the PTY child processes boot concurrently anyway, and
  // running the per-session setup work in parallel lets the sync filesystem
  // I/O (transcript shadow restore, sessionStore lookups) interleave via the
  // microtask queue instead of blocking the event loop serially. Each task
  // starts with `await setImmediate` so the WS upgrade handler and first
  // snapshot send win the first event-loop tick.
  await Promise.all(sessions.map(async ({ sessionId, cwd, provider, providerSessionId }) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (provider === 'opencode') {
      try {
        ptyManager.spawn(sessionId, cwd, 220, 50, buildOpencodeResumeArgs(providerSessionId), 'opencode');
        const pid = ptyManager.getPid(sessionId) ?? 0;
        stateManager.reviveManagedProviderSession(sessionId, pid);
        ovrToPty.set(sessionId, sessionId);
        ptyToOvr.set(sessionId, sessionId);
        console.log(`[auto-resume] resumed OpenCode PTY ${sessionId.slice(0, 8)}`);
      } catch (err) {
        console.warn(`[auto-resume] failed to resume OpenCode PTY for ${sessionId.slice(0, 8)}:`, err);
      }
      return;
    }
    // Claude --resume requires the transcript file to exist at
    // ~/.claude/projects/<slug>/<sessionId>.jsonl. If cleanupStaleTranscripts
    // (or archive/delete) removed it, spawning blindly just prints
    // "No conversation found" and exits. Skip and mark the session deleted so
    // it stops reappearing in the UI and is not retried on the next restart.
    const resolved = resolveResumableSessionId(sessionId, cwd);
    if (!resolved) {
      // Skip the resume but DO NOT delete the OverlordSession record. A
      // missing transcript on one sid doesn't invalidate the whole lineage:
      // the record may still hold artifacts (plans, color, title, history)
      // and the sid can become resolvable later (shadow link, restore, etc).
      // Past behavior of `markDeleted + sessionStore.removeBySessionId` was
      // the source of the OV Cedar disappearance — once a sid landed in
      // deleted-sessions.json, hydrate skipped it forever.
      console.warn(`[auto-resume] skipping ${sessionId.slice(0, 8)}: transcript missing (record retained)`);
      return;
    }
    const effectiveResumeId = resolved.sessionId;
    if (effectiveResumeId !== sessionId) {
      console.log(`[auto-resume] ${sessionId.slice(0, 8)} jsonl missing — falling back to ancestor ${effectiveResumeId.slice(0, 8)}`);
    }
    // If the resolved transcript lives only in the shadow store, claude --resume
    // will start but its TUI cannot load the conversation (it looks at the
    // canonical project dir, not the shadow). Hard-link shadow → canonical so
    // the conversation loads. Without this, the input loop silently dies.
    if (resolved.transcriptPath.startsWith(SHADOW_ROOT_DIR)) {
      const ovr = sessionStore.getBySessionId(effectiveResumeId);
      if (ovr) {
        const restored = restoreCanonicalFromShadow(ovr.overlordId, effectiveResumeId, cwd);
        if (restored) {
          console.log(`[auto-resume] restored canonical transcript for ${effectiveResumeId.slice(0, 8)} from shadow`);
        } else {
          console.warn(`[auto-resume] failed to restore canonical for ${effectiveResumeId.slice(0, 8)}; --resume may not load`);
        }
      }
    }
    const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // Seed the marker→resumeTarget map BEFORE spawning. spawn returns once
      // the child claude is launched; that claude writes its `{pid}.json`
      // file, which sessionWatcher picks up via chokidar `add`, which calls
      // addOrUpdate — and consumePendingResumeByMarker must already see the
      // entry, otherwise the new sid gets a fresh ovr instead of attaching to
      // the original lineage.
      stateManager.trackPendingResumeByMarker(ptySessionId, effectiveResumeId);
      // Reserve the existing lineage's ovrId against this marker so the new
      // sid created by claude --resume re-joins instead of splitting off.
      const existingOvrId = sessionStore.resolveOverlordId(sessionId);
      if (existingOvrId) stateManager.reserveOvrIdForMarker(ptySessionId, existingOvrId);
      ptyManager.spawn(ptySessionId, cwd, 220, 50, ['--resume', effectiveResumeId, '--name', `___OVR:${ptySessionId}`]);
      // Also reserve by PID once the child process exists. claude --resume
      // sometimes drops the --name marker from {pid}.json, so the marker
      // reservation can miss; PID always matches.
      if (existingOvrId) {
        const pid = ptyManager.getPid(ptySessionId);
        if (pid) stateManager.reserveOvrIdForPid(pid, existingOvrId);
        else ptyManager.once('pid-ready', (sid: string, p: number) => {
          if (sid === ptySessionId && p) stateManager.reserveOvrIdForPid(p, existingOvrId);
        });
      }
      linkageTracker.trackResume(effectiveResumeId, { ptySessionId, timestamp: Date.now() });
      console.log(`[auto-resume] spawned PTY ${ptySessionId} for session ${sessionId.slice(0, 8)}`);
    } catch (err) {
      console.warn(`[auto-resume] failed to spawn PTY for ${sessionId.slice(0, 8)}:`, err);
    }
  }));
}
