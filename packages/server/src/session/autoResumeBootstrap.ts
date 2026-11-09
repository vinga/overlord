import type { StateManager } from './stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import type { PtyLinkageTracker } from './ptyLinkageTracker.js';
import { resolveResumableSessionId } from './transcriptReader.js';
import { restoreCanonicalFromShadow, SHADOW_ROOT_DIR } from './transcriptShadow.js';
import { buildOpencodeResumeArgs } from './opencodeSession.js';
import { buildCodexResumeArgs, scheduleCodexTranscriptCapture } from './codexSession.js';
import { sessionStore } from './sessionStore.js';
import type { LiveAtShutdownEntry } from './liveAtShutdownStore.js';
import * as fs from 'fs';

/** Resumes running at once. Each `claude --resume` redraws its whole
 *  conversation through the headless terminal on the main thread; 24 at once
 *  starved the event loop for ~60s (first transcript poll: 58.6s). */
export const RESUME_CONCURRENCY = 2;
/** A resumed PTY frees its slot once its output has been quiet this long… */
export const RESUME_QUIET_MS = 1500;
/** …or after this long at most (a TUI with a spinner never goes quiet). */
export const RESUME_CAP_MS = 12_000;

type ResumeItem = { sessionId: string; cwd: string; provider?: string; providerSessionId?: string };

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
 *  - codex: `codex resume <providerSessionId>`, revive, re-link the new rollout.
 *    Must never reach the claude path — `claude --resume codex-…` starts an
 *    unrelated Claude session that then replaces the Codex card.
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
  console.log(`[auto-resume] resuming ${sessions.length} of ${captured.length} live-at-shutdown session(s), ${RESUME_CONCURRENCY} at a time, most recent first`);
  const started = Date.now();
  const ordered = orderByRecency(sessions, deps);
  let n = 0;
  await runResumeQueue(ordered, {
    concurrency: RESUME_CONCURRENCY,
    // The user may have resumed it by hand while it waited in the queue.
    alreadyLive: (item) => hasLivePty(item.sessionId, deps),
    resume: async (item) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      n++;
      console.log(`[auto-resume] ${n}/${ordered.length} resuming ${item.sessionId.slice(0, 8)}`);
      return resumeOne(item, deps);
    },
    settle: (ptyId) => waitForQuiet(ptyId, deps.ptyManager, RESUME_QUIET_MS, RESUME_CAP_MS),
  });
  console.log(`[auto-resume] done: ${ordered.length} session(s) in ${Math.round((Date.now() - started) / 1000)}s`);
}

/** Newest transcript first (transcript mtime — the freshness source, not
 *  `lastActivity`); sessions without a readable transcript go last. */
export function orderByRecency<T extends ResumeItem>(items: T[], deps: Pick<AutoResumeDeps, 'stateManager'>): T[] {
  const mtime = (item: T): number => {
    try {
      const path = item.provider === 'codex' || item.provider === 'opencode'
        ? (deps.stateManager as { getSession?: (sid: string) => { transcriptPath?: string } | undefined }).getSession?.(item.sessionId)?.transcriptPath
        : resolveResumableSessionId(item.sessionId, item.cwd)?.transcriptPath;
      return path ? fs.statSync(path).mtimeMs : 0;
    } catch { return 0; }
  };
  return items
    .map(item => ({ item, t: mtime(item) }))
    .sort((a, b) => b.t - a.t)
    .map(({ item }) => item);
}

/** Pull items through `concurrency` workers. A worker resumes an item, then
 *  holds its slot until `settle` resolves for the spawned PTY. */
export async function runResumeQueue<T>(items: T[], opts: {
  concurrency: number;
  alreadyLive: (item: T) => boolean;
  resume: (item: T) => Promise<string | null>;
  settle: (ptyId: string) => Promise<void>;
}): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (opts.alreadyLive(item)) continue;
      const ptyId = await opts.resume(item);
      if (ptyId) await opts.settle(ptyId);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
}

/** Resolves when `ptyId` has produced no output for `quietMs`, after `capMs`,
 *  or when it exits — whichever comes first. */
export function waitForQuiet(
  ptyId: string,
  ptyManager: AutoResumeDeps['ptyManager'],
  quietMs: number,
  capMs: number,
): Promise<void> {
  const pm = ptyManager as unknown as {
    on?: (ev: string, fn: (...a: unknown[]) => void) => void;
    off?: (ev: string, fn: (...a: unknown[]) => void) => void;
  };
  if (typeof pm.on !== 'function' || typeof pm.off !== 'function') return Promise.resolve();
  return new Promise<void>(resolve => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      pm.off!('output', onOutput);
      pm.off!('exit', onExit);
      resolve();
    };
    const onOutput = (id: unknown) => {
      if (id !== ptyId) return;
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    };
    const onExit = (id: unknown) => { if (id === ptyId) done(); };
    quiet = setTimeout(done, quietMs);
    const cap = setTimeout(done, capMs);
    pm.on!('output', onOutput);
    pm.on!('exit', onExit);
  });
}

function hasLivePty(sessionId: string, deps: AutoResumeDeps): boolean {
  const ovr = sessionStore.resolveOverlordId(sessionId) ?? sessionId;
  const ptyId = deps.ovrToPty.get(ovr) ?? deps.ovrToPty.get(sessionId);
  const pm = deps.ptyManager as unknown as { has?: (id: string) => boolean };
  return !!ptyId && typeof pm.has === 'function' && pm.has(ptyId);
}

/** Resume one session (provider-specific). Returns the spawned PTY id, or
 *  null when skipped or failed. */
async function resumeOne({ sessionId, cwd, provider, providerSessionId }: ResumeItem, deps: AutoResumeDeps): Promise<string | null> {
  const { stateManager, ptyManager, ovrToPty, ptyToOvr, linkageTracker } = deps;
  {
    if (provider === 'opencode') {
      try {
        ptyManager.spawn(sessionId, cwd, 220, 50, buildOpencodeResumeArgs(providerSessionId), 'opencode');
        const pid = ptyManager.getPid(sessionId) ?? 0;
        stateManager.reviveManagedProviderSession(sessionId, pid);
        ovrToPty.set(sessionId, sessionId);
        ptyToOvr.set(sessionId, sessionId);
        console.log(`[auto-resume] resumed OpenCode PTY ${sessionId.slice(0, 8)}`);
        return sessionId;
      } catch (err) {
        console.warn(`[auto-resume] failed to resume OpenCode PTY for ${sessionId.slice(0, 8)}:`, err);
      }
      return null;
    }
    if (provider === 'codex') {
      try {
        // `codex resume` continues into a fresh rollout file; only rollouts
        // written after the spawn are candidates for re-linking.
        const startedAfterMs = Date.now() - 2_000;
        ptyManager.spawn(sessionId, cwd, 220, 50, buildCodexResumeArgs(providerSessionId, sessionId), 'codex');
        const pid = ptyManager.getPid(sessionId) ?? 0;
        stateManager.reviveManagedProviderSession(sessionId, pid);
        ovrToPty.set(sessionId, sessionId);
        ptyToOvr.set(sessionId, sessionId);
        scheduleCodexTranscriptCapture(stateManager, sessionId, cwd, startedAfterMs, { replaceExisting: true });
        console.log(`[auto-resume] resumed Codex PTY ${sessionId.slice(0, 18)}`);
        return sessionId;
      } catch (err) {
        console.warn(`[auto-resume] failed to resume Codex PTY for ${sessionId.slice(0, 18)}:`, err);
      }
      return null;
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
      return null;
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
      return ptySessionId;
    } catch (err) {
      console.warn(`[auto-resume] failed to spawn PTY for ${sessionId.slice(0, 8)}:`, err);
    }
  }
  return null;
}
