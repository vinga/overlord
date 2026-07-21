import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import type { WebSocket, WebSocketServer } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe, nudgeBridgePipe, resizeAndNudgeBridgePipe, getBridgePath } from '../pty/pipeInjector.js';
import { injectViaMac } from '../pty/macInjector.js';
import { log } from '../logger.js';
import { focusBridgeWindow } from '../pty/windowFocus.js';
import { scheduleInject, scheduleBridgeInject } from '../pty/injectScheduler.js';
import { spawnClaudeSession } from '../pty/spawnSession.js';
import { writeMeta as writeShellHistoryMeta, readAll as readShellHistory, hasLog as hasShellHistory } from '../pty/shellHistoryLog.js';
import { archiveManager } from '../archive/archiveManager.js';
import { wsVisible, wsSnapshotOptOut, wsTermSubs, subscribeTerminal, clearClientState } from './wsClientState.js';
import { findTranscriptPath, findTranscriptPathAnywhere, resolveResumableSessionId } from '../session/transcriptReader.js';
import { buildOpencodeResumeArgs, findLatestOpencodeSessionId } from '../session/opencodeSession.js';
import { sessionStore } from '../session/sessionStore.js';

export interface WsHandlerContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ovrToPty: Map<string, string>;     // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;     // ptySessionId → ovrId
  linkageTracker: import('../session/ptyLinkageTracker.js').PtyLinkageTracker;
  ptyOutputBuffer: Map<string, Buffer[]>;
  broadcastRaw: (msg: object) => void;
  broadcastTerminalOutput: (termId: string, msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void;
  openTerminalWindow: (cwd: string, command: string, title?: string, sessionId?: string, useBridge?: boolean) => Promise<void>;
  autoResumePtySessions: () => Promise<void>;
  getLogBuffer: () => unknown[];
}


// BSU (\x1b[?2026h) marks the start of a synchronized full-screen TUI repaint.
// For `terminal:replay`, we only want to send chunks from the last BSU onward —
// that is a coherent frame boundary. When the TUI is mid-work and hasn't emitted
// a BSU in a while, the buffer may contain hundreds of chunks of streamed tool
// output. Concat'ing all of them makes xterm scroll-write incremental draws and
// feels slow. If no BSU is present we return [] and rely on the SIGWINCH nudge
// to produce the next full frame.
const BSU_MARKER = Buffer.from('\x1b[?2026h');
export function sliceBufferFromLastBsu(buf: Buffer[] | undefined): Buffer[] {
  if (!buf || buf.length === 0) return [];
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].indexOf(BSU_MARKER) >= 0) return buf.slice(i);
  }
  return [];
}

function stripInternalMarkers(name: string): string {
  return name.replace(/___(?:BRG|OVR):[A-Za-z0-9_-]*/g, '').replace(/[-_\s]+$/, '').trim();
}

function resolveCliProvider(provider?: string): 'claude' | 'opencode' {
  return provider === 'opencode' ? 'opencode' : 'claude';
}

// Returns { pid, killable } for an existing `claude --resume <sessionId>` process.
// `killable` = true means we know it's ours (one of these conditions):
//   - ppid === current server pid (dangling child from THIS boot, PTY link dropped)
//   - command line carries our `___OVR:` or `___BRG:` marker (orphan from a PRIOR
//     boot reparented to launchd — still our process, still safe to kill).
// Non-killable = a foreign claude the user launched outside Overlord. Refuse and
// surface an actionable error rather than killing arbitrary processes.
async function findExistingClaudeResumePid(
  sessionId: string,
): Promise<{ pid: number; killable: boolean } | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout: out } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,command=']);
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmd = m[3];
      if (pid === process.pid) continue;
      if (!/\bclaude\b/.test(cmd)) continue;
      if (cmd.includes(`--resume ${sessionId}`)) {
        const ownChild = ppid === process.pid;
        const carriesOurMarker = /___(OVR|BRG):/.test(cmd);
        return { pid, killable: ownChild || carriesOurMarker };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function scheduleOpencodeSessionIdCapture(
  stateManager: StateManager,
  sessionId: string,
  cwd: string,
  startedAfterMs: number,
): void {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const found = findLatestOpencodeSessionId(cwd, startedAfterMs);
    if (found) {
      clearInterval(timer);
      stateManager.setProviderSessionId(sessionId, found);
      return;
    }
    if (attempts >= 15) {
      clearInterval(timer);
    }
  }, 1000);
}

export function setupWebSocketHandler(wss: WebSocketServer, ctx: WsHandlerContext): void {
  const {
    stateManager,
    ptyManager,
    wsSessionMap,
    ovrToPty,
    ptyToOvr,
    linkageTracker,
    ptyOutputBuffer,
    broadcastRaw,
    broadcastTerminalOutput,
    sendToClient,
    deleteSession,
    openTerminalWindow,
    autoResumePtySessions,
    getLogBuffer,
  } = ctx;

  let autoResumeTriggered = false;

  // Per-WS visibility/subscription state lives in wsClientState.ts — shared
  // with index.ts, whose broadcast() skips hidden clients and
  // broadcastTerminalOutput() sends only to subscribed ones.
  const recomputePolling = (): void => {
    let anyVisible = false;
    for (const v of wsVisible.values()) {
      if (v) { anyVisible = true; break; }
    }
    stateManager.getPrCache().setPollingEnabled(anyVisible);
  };

  wss.on('connection', (ws) => {
    // Trigger auto-resume on the first client connection. Defer to the next
    // tick so the snapshot/log:history sends below run first — otherwise the
    // synchronous prefix of autoResumePtySessions delays the first frames the
    // client sees, leaving the UI blank during the PTY spawn-storm.
    if (!autoResumeTriggered) {
      autoResumeTriggered = true;
      if (process.env.OVERLORD_AUTO_RESUME === '1') {
        setImmediate(() => {
          autoResumePtySessions().catch(err => console.warn('[auto-resume] error:', err));
        });
      } else {
        console.log('[auto-resume] disabled (set OVERLORD_AUTO_RESUME=1 to enable)');
      }
    }

    // Register this client in the session map
    wsSessionMap.set(ws, new Set());
    wsVisible.set(ws, true);
    recomputePolling();

    const snapshot = stateManager.getSnapshot();
    ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }));
    ws.send(JSON.stringify({ type: 'log:history', entries: getLogBuffer() }));

    // Replay active PTY session links so the terminal tab shows on fresh connects / reloads.
    // Keyed by ovrId → ptyId; include claudeSessionId so client can route messages.
    const wsSessions = wsSessionMap.get(ws)!;
    for (const [ovrId, ptySessionId] of ovrToPty) {
      if (!ptyManager.has(ptySessionId)) continue; // skip dead PTYs
      const claudeSession = stateManager.getActiveClaudeByOvr(ovrId);
      const claudeSessionId = claudeSession?.sessionId ?? ovrId;
      wsSessions.add(ovrId);
      wsSessions.add(ptySessionId);
      sendToClient(ws, { type: 'terminal:linked', ovrId, ptySessionId, claudeSessionId, replay: true });
      // Intentionally do NOT dump the full ptyOutputBuffer here. The client
      // triggers `terminal:replay` when xterm mounts (useTerminal.registerOutputHandler),
      // and that path already BSU-slices for TUIs and caps for raw shells. Sending
      // the whole buffer here doubled the work and pushed 5–10 MB through base64.
    }
    // Replay active bridge session links (bridge sessions don't use ptyManager).
    // Bridge ovrId is stored on the session's overlordId field.
    for (const [bridgeSessionId] of Object.entries(stateManager.deriveBridgeRegistry())) {
      const bridgeSess = stateManager.getSession(bridgeSessionId);
      const bridgeOvrId = bridgeSess?.overlordId ?? bridgeSessionId;
      sendToClient(ws, { type: 'terminal:linked', ovrId: bridgeOvrId, ptySessionId: `bridge-${bridgeSessionId}`, claudeSessionId: bridgeSessionId, replay: true });
      // Don't send historical buffer — terminal:replay will trigger a fresh nudge instead
    }

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return; // ignore non-JSON
      }

      const { type } = msg;

      if (type === 'visibility') {
        const visible = msg.visible !== false;
        const wasVisible = wsVisible.get(ws) !== false;
        wsVisible.set(ws, visible);
        recomputePolling();
        // Hidden tabs are skipped by snapshot broadcasts — push a fresh
        // snapshot on the hidden→visible flip so the tab never shows stale state.
        if (visible && !wasVisible && !wsSnapshotOptOut.has(ws)) {
          sendToClient(ws, { type: 'snapshot', ...stateManager.getSnapshot() });
        }
        return;
      }

      // LogsPage socket: only consumes log:history/log:entry — never send it
      // the 300–600 KB snapshot stream.
      if (type === 'snapshot:optout') {
        wsSnapshotOptOut.add(ws);
        return;
      }

      // xterm unmounted on the client — stop pushing this terminal's output.
      if (type === 'terminal:unsubscribe') {
        wsTermSubs.get(ws)?.delete(String(msg.sessionId ?? ''));
        return;
      }

      if (type === 'terminal:spawn') {
        const cwd = String(msg.cwd ?? process.cwd());
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const name = msg.name ? String(msg.name) : undefined;
        const provider = resolveCliProvider(typeof msg.provider === 'string' ? msg.provider : undefined);

        // Auto-create directory if it doesn't exist
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
          console.log(`[spawn] created directory: ${cwd}`);
        }

        if (provider === 'opencode') {
          const sessionId = `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const startedAfterMs = Date.now() - 2_000;
          stateManager.addManagedProviderSession(sessionId, cwd, 0, 'opencode', name);
          ovrToPty.set(sessionId, sessionId);
          ptyToOvr.set(sessionId, sessionId);

          const sessions = wsSessionMap.get(ws);
          if (sessions) sessions.add(sessionId);

          broadcastRaw({ type: 'terminal:spawned', sessionId, pid: 0 });
          try {
            ptyManager.spawn(sessionId, cwd, cols, rows, [], 'opencode');
            const pid = ptyManager.getPid(sessionId) ?? 0;
            if (pid) stateManager.setPid(sessionId, pid);
            log('pty:started', 'OpenCode PTY session started', { sessionId, sessionName: name ?? sessionId.slice(0, 8) });
            broadcastRaw({ type: 'terminal:linked', ovrId: sessionId, ptySessionId: sessionId, claudeSessionId: sessionId });
            scheduleOpencodeSessionIdCapture(stateManager, sessionId, cwd, startedAfterMs);
          } catch (err) {
            stateManager.remove(sessionId);
            sessionStore.removeBySessionId(sessionId);
            ovrToPty.delete(sessionId);
            ptyToOvr.delete(sessionId);
            sendToClient(ws, {
              type: 'terminal:error',
              sessionId,
              message: `Spawn failed: ${(err as Error).message}`,
            });
          }
          return;
        }

        // Optional initial prompt — injected once the TUI is ready.
        const initialPrompt = msg.prompt ? String(msg.prompt) : undefined;
        try {
          // Shared fresh-spawn path (mints ovrId, wires maps, queues the
          // initial prompt, broadcasts terminal:spawned, spawns the PTY).
          spawnClaudeSession(
            { ptyManager, stateManager, ovrToPty, ptyToOvr, broadcastRaw },
            { cwd, name, cols, rows, prompt: initialPrompt, sessions: wsSessionMap.get(ws) },
          );
          // pid-ready event handler populates pendingPtyByPid asynchronously
        } catch (err) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: (err as { ovrId?: string }).ovrId,
            message: `Spawn failed: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (type === 'terminal:resume') {
        const resumeSessionId = String(msg.resumeSessionId ?? '');
        const cwd = String(msg.cwd ?? process.cwd());
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const targetSession = stateManager.getSession(resumeSessionId);
        const provider = resolveCliProvider(targetSession?.provider);

        if (provider === 'opencode' && targetSession) {
          const startedAfterMs = Date.now() - 2_000;
          const ptySessionId = resumeSessionId;
          const sessions = wsSessionMap.get(ws);
          if (sessions) sessions.add(ptySessionId);
          ovrToPty.set(ptySessionId, ptySessionId);
          ptyToOvr.set(ptySessionId, ptySessionId);

          sendToClient(ws, { type: 'terminal:spawned', sessionId: ptySessionId, pid: 0 });
          try {
            ptyManager.spawn(ptySessionId, cwd, cols, rows, buildOpencodeResumeArgs(targetSession.providerSessionId), 'opencode');
            const pid = ptyManager.getPid(ptySessionId) ?? 0;
            stateManager.reviveManagedProviderSession(resumeSessionId, pid);
            log('pty:started', 'OpenCode PTY session resumed', {
              sessionId: ptySessionId,
              sessionName: targetSession.proposedName ?? resumeSessionId.slice(0, 8),
            });
            broadcastRaw({
              type: 'terminal:linked',
              ovrId: targetSession.overlordId ?? resumeSessionId,
              ptySessionId,
              claudeSessionId: resumeSessionId,
            });
            if (!targetSession.providerSessionId) {
              scheduleOpencodeSessionIdCapture(stateManager, resumeSessionId, cwd, startedAfterMs);
            }
          } catch (err) {
            ovrToPty.delete(ptySessionId);
            ptyToOvr.delete(ptySessionId);
            sendToClient(ws, {
              type: 'terminal:error',
              sessionId: ptySessionId,
              message: `Resume failed: ${(err as Error).message}`,
            });
          }
          return;
        }

        const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // For resume (NOT clone/fork): reuse the existing lineage's ovrId so
        // the resumed session lands in the same OverlordSession record. Minting
        // a fresh ovrId here would split the lineage in two — same name, two
        // ovr records, two visible workers. Falls back to a fresh reservation
        // only when the resume target is unknown to stateManager (orphan).
        const existingOvrId = targetSession?.overlordId
          ?? sessionStore.resolveOverlordId(resumeSessionId);
        const ovrId = existingOvrId
          ? (stateManager.reserveOvrIdForMarker(ptySessionId, existingOvrId), existingOvrId)
          : stateManager.mintReservedOvrId(ptySessionId);
        ovrToPty.set(ovrId, ptySessionId);
        ptyToOvr.set(ptySessionId, ovrId);

        // Resolve to a sessionId whose jsonl actually exists. When a resumed session
        // keeps writing to the parent's jsonl (no new {sessionId}.jsonl is created),
        // the current sessionId is unresumable — fall back to a lineage ancestor.
        const resolved = resolveResumableSessionId(resumeSessionId, cwd);
        if (!resolved) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ptySessionId,
            message: `Cannot resume ${resumeSessionId.slice(0, 8)}: transcript no longer exists.`,
          });
          return;
        }
        const effectiveResumeId = resolved.sessionId;
        if (effectiveResumeId !== resumeSessionId) {
          console.log(`[terminal:resume] ${resumeSessionId.slice(0, 8)} jsonl missing — falling back to ancestor ${effectiveResumeId.slice(0, 8)}`);
        }

        // A second `claude --resume <sid>` collides with claude's session lock
        // and exits immediately. Detect an existing one; if it's OUR child
        // (dangling from this boot — PTY/ovrToPty link was dropped), kill it
        // to free the lock and proceed. If it's foreign (e.g. orphan from a
        // prior boot reparented to launchd), refuse with an actionable error.
        const existing = await findExistingClaudeResumePid(effectiveResumeId);
        if (existing !== null) {
          if (existing.killable) {
            console.log(
              `[terminal:resume] killing existing overlord-owned claude pid=${existing.pid} holding ${effectiveResumeId.slice(0, 8)} to free session lock`,
            );
            try { process.kill(existing.pid, 'SIGTERM'); } catch { /* ignore */ }
            // Wait up to 300ms for claude to release the lock before we
            // spawn the replacement. claude typically exits within ~100ms of
            // SIGTERM; the previous 2s ceiling padded session-resume by 1.5s+
            // on every orphan kill. Escalate to SIGKILL fast — a zombie can't
            // hold the lock anyway. Poll with async sleeps so the WS event
            // loop stays responsive.
            const deadline = Date.now() + 300;
            let alive = true;
            while (Date.now() < deadline) {
              try { process.kill(existing.pid, 0); } catch { alive = false; break; }
              await new Promise((r) => setTimeout(r, 25));
            }
            if (alive) {
              try { process.kill(existing.pid, 'SIGKILL'); } catch { /* ignore */ }
              // Brief follow-up wait for kernel to tear down the lock holder.
              await new Promise((r) => setTimeout(r, 50));
            }
          } else {
            sendToClient(ws, {
              type: 'terminal:error',
              sessionId: ptySessionId,
              message: `Cannot resume: claude process (pid ${existing.pid}) is already attached to this session and was not launched by Overlord. Kill it first: kill ${existing.pid}`,
            });
            return;
          }
        }

        stateManager.trackPendingResume(cwd, effectiveResumeId);
        stateManager.trackPendingResumeByMarker(ptySessionId, effectiveResumeId);
        const resumedName = stateManager.getSession(resumeSessionId)?.proposedName ?? resumeSessionId.slice(0, 8);
        log('session:resumed', 'Session resumed', { sessionId: effectiveResumeId, sessionName: resumedName });

        const sessions = wsSessionMap.get(ws);
        if (sessions) { sessions.add(ovrId); sessions.add(ptySessionId); }

        sendToClient(ws, { type: 'terminal:spawned', sessionId: ovrId, pid: 0 });
        try {
          ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', effectiveResumeId, '--name', `___OVR:${ptySessionId}`]);
          const resumePtyName = stateManager.getSession(resumeSessionId)?.proposedName ?? resumeSessionId.slice(0, 8);
          log('pty:started', 'PTY session started', { sessionId: ovrId, sessionName: resumePtyName });

          // Immediately flip the closed session back to 'waiting'. The PTY is
          // alive and linked (ovrToPty set above) — the worker is reachable now.
          // We can't wait for the watcher: newer `claude --resume` does NOT write
          // ~/.claude/sessions/{pid}.json for PTY children, so the old liveness
          // signal never arrives, and the transcript is only mtime-touched (no new
          // content) until the user sends a message. Without this the worker stays
          // 'closed' → client reverts to "Session exited". Mirrors the opencode
          // path's reviveManagedProviderSession and the bridge reconnect revive.
          // The process-checker won't re-close it: pid is 0 (skipped) and the
          // transcript mtime guard (120s) covers the freshly-touched jsonl.
          stateManager.reviveClosedSession(resumeSessionId);
          if (effectiveResumeId !== resumeSessionId) stateManager.reviveClosedSession(effectiveResumeId);

          linkageTracker.trackResume(effectiveResumeId, { ptySessionId, ws, timestamp: Date.now() });
        } catch (err) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ovrId,
            message: `Resume failed: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (type === 'terminal:open-external') {
        const sessionId = String(msg.sessionId ?? '');
        const cwd = String(msg.cwd ?? process.cwd());
        const session = stateManager.getSession(sessionId);
        const sessionName = stripInternalMarkers(session?.proposedName ?? sessionId.slice(0, 8));
        const provider = resolveCliProvider(session?.provider);
        const resolvedExternal = provider === 'claude' ? resolveResumableSessionId(sessionId, cwd) : null;
        const externalResumeId = resolvedExternal?.sessionId ?? sessionId;
        if (resolvedExternal && externalResumeId !== sessionId) {
          console.log(`[open-external] ${sessionId.slice(0, 8)} jsonl missing — falling back to ancestor ${externalResumeId.slice(0, 8)}`);
        }
        const command = provider === 'opencode'
          ? `opencode ${session?.providerSessionId ? `--session ${session.providerSessionId}` : '--continue'}`
          : `claude --resume ${externalResumeId} --name "${sessionName.replace(/"/g, '')}"`;
        console.log(`[open-external] sessionId=${sessionId} cwd=${cwd}`);
        stateManager.setSessionType(sessionId, 'plain');
        openTerminalWindow(cwd, command, `${provider === 'opencode' ? 'OpenCode' : 'Claude'}: ${sessionName}`, sessionId)
          .then(() => sendToClient(ws, { type: 'terminal:external-opened', sessionId }))
          .catch((err) => sendToClient(ws, { type: 'terminal:error', sessionId, message: `Failed to open terminal: ${(err as Error).message}` }));
        return;
      }

      if (type === 'terminal:open-bridged') {
        // Open a new terminal window running the bridge command for this session.
        // The bridge connects to a named pipe; Overlord detects the ___BRG:<marker> name
        // and links the PTY output to this session automatically.
        const sessionId = String(msg.sessionId ?? '');
        const cwd = String(msg.cwd ?? process.cwd());

        const session = stateManager.getSession(sessionId);
        const sessionName = stripInternalMarkers(session?.proposedName ?? sessionId.slice(0, 8));
        const provider = resolveCliProvider(session?.provider);
        const marker = sessionId.slice(0, 8);
        const safeName = sessionName.replace(/"/g, '-');
        const bridgePath = getBridgePath();
        const resolvedBridge = provider === 'claude' ? resolveResumableSessionId(sessionId, cwd) : null;
        const bridgeResumeId = resolvedBridge?.sessionId ?? sessionId;
        if (resolvedBridge && bridgeResumeId !== sessionId) {
          console.log(`[open-bridged] ${sessionId.slice(0, 8)} jsonl missing — falling back to ancestor ${bridgeResumeId.slice(0, 8)}`);
        }
        const resumeCmd = provider === 'opencode'
          ? `opencode ${session?.providerSessionId ? `--session ${session.providerSessionId}` : '--continue'}`
          : `claude --resume ${bridgeResumeId} --name "${safeName}___BRG:${marker}"`;
        const command = `"${bridgePath}" --pipe overlord-${marker} -- ${resumeCmd}`;
        console.log(`[open-bridged] sessionId=${sessionId} marker=${marker}`);
        openTerminalWindow(cwd, command, `Bridge: ${sessionName}`, undefined, false)
          .then(() => sendToClient(ws, { type: 'terminal:bridge-opened', sessionId }))
          .catch((err) => sendToClient(ws, { type: 'terminal:error', sessionId, message: `Failed to open bridge terminal: ${(err as Error).message}` }));
        return;
      }

      if (type === 'terminal:open-new') {
        const cwd = String(msg.cwd ?? process.cwd());
        const name = msg.name ? String(msg.name) : undefined;
        const mode = msg.mode ? String(msg.mode) : undefined;
        const provider = resolveCliProvider(typeof msg.provider === 'string' ? msg.provider : undefined);

        // Auto-create directory if it doesn't exist
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
          console.log(`[open-new] created directory: ${cwd}`);
        }

        const cwdName = name || cwd.split(/[\\/]/).pop() || 'New';
        const safeCwdName = cwdName.replace(/"/g, '');
        console.log(`[open-new] cwd=${cwd} name=${cwdName} mode=${mode ?? 'default'}`);
        const command = provider === 'opencode' ? 'opencode' : `claude --name "${safeCwdName}"`;
        openTerminalWindow(cwd, command, `${provider === 'opencode' ? 'OpenCode' : 'Claude'}: ${cwdName}`, undefined, mode !== 'plain')
          .then(() => sendToClient(ws, { type: 'terminal:new-opened' }))
          .catch((err) => sendToClient(ws, { type: 'terminal:error', message: `Failed to open terminal: ${(err as Error).message}` }));
        return;
      }

      if (type === 'terminal:spawn-raw') {
        const cwd = String(msg.cwd ?? process.cwd());
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const name = msg.name ? String(msg.name) : undefined;

        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
          console.log(`[spawn-raw] created directory: ${cwd}`);
        }

        const rawId = `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const shell = process.platform === 'win32'
          ? (process.env.COMSPEC || 'powershell.exe')
          : (process.env.SHELL || '/bin/bash');

        stateManager.addRawSession(rawId, cwd, 0, name);
        writeShellHistoryMeta(rawId, { cwd, name });
        ovrToPty.set(rawId, rawId);
        ptyToOvr.set(rawId, rawId);

        const sessions = wsSessionMap.get(ws);
        if (sessions) { sessions.add(rawId); }

        broadcastRaw({ type: 'terminal:spawned', sessionId: rawId, pid: 0 });

        try {
          ptyManager.spawn(rawId, cwd, cols, rows, [], shell);
          const pid = ptyManager.getPid(rawId) ?? 0;
          if (pid) stateManager.setPid(rawId, pid);
          log('pty:started', 'Raw shell started', { sessionId: rawId, sessionName: name ?? 'shell', extra: `shell=${shell} pid=${pid}` });
          // Broadcast terminal:linked right away — no session file to wait for.
          broadcastRaw({ type: 'terminal:linked', ovrId: rawId, ptySessionId: rawId, claudeSessionId: rawId });
        } catch (err) {
          stateManager.remove(rawId);
          ovrToPty.delete(rawId);
          ptyToOvr.delete(rawId);
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: rawId,
            message: `Raw shell spawn failed: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (type === 'terminal:restart-shell') {
        const ovrId = String(msg.sessionId ?? '');
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const session = stateManager.getSession(ovrId);
        if (!session || session.sessionType !== 'raw') {
          sendToClient(ws, { type: 'terminal:error', sessionId: ovrId, message: 'Not a raw shell session' });
          return;
        }
        const cwd = session.cwd;
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
        }
        const shell = process.platform === 'win32'
          ? (process.env.COMSPEC || 'powershell.exe')
          : (process.env.SHELL || '/bin/bash');

        ovrToPty.set(ovrId, ovrId);
        ptyToOvr.set(ovrId, ovrId);
        const sessions = wsSessionMap.get(ws);
        if (sessions) { sessions.add(ovrId); }

        try {
          ptyManager.spawn(ovrId, cwd, cols, rows, [], shell);
          const pid = ptyManager.getPid(ovrId) ?? 0;
          stateManager.reviveRawToWorking(ovrId, pid);
          writeShellHistoryMeta(ovrId, { cwd, name: session.proposedName });
          log('pty:started', 'Raw shell restarted', { sessionId: ovrId, sessionName: session.proposedName ?? 'shell', extra: `shell=${shell} pid=${pid}` });
          // Dim separator banner before the new shell starts emitting output.
          const banner = `\r\n\x1b[2m── shell restarted · ${new Date().toISOString()} ──\x1b[0m\r\n`;
          broadcastRaw({ type: 'terminal:output', sessionId: ovrId, data: Buffer.from(banner).toString('base64') });
          // replay=true so the client doesn't wipe the visible scrollback on link.
          broadcastRaw({ type: 'terminal:linked', ovrId, ptySessionId: ovrId, claudeSessionId: ovrId, replay: true });
        } catch (err) {
          ovrToPty.delete(ovrId);
          ptyToOvr.delete(ovrId);
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ovrId,
            message: `Raw shell restart failed: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (type === 'terminal:input') {
        const ovrId = String(msg.sessionId ?? '');
        const data = String(msg.data ?? '');
        // Typing into a terminal implies watching it — defensive subscribe in
        // case the terminal:replay of the mount was lost (e.g. WS reconnect).
        subscribeTerminal(ws, ovrId);
        // Resolve Claude session for bridge/PID info (fallback: treat ovrId as claudeId)
        const claudeSession = stateManager.getActiveClaudeByOvr(ovrId) ?? stateManager.getSession(ovrId);
        const claudeSessionId = claudeSession?.sessionId ?? ovrId;
        const pid = claudeSession?.pid;
        stateManager.clearHintOnInput(claudeSessionId);
        const ptyId = ovrToPty.get(ovrId);
        const wrote = ptyManager.write(ptyId ?? ovrId, data);
        if (!wrote) {
          // No PTY session — fall back to bridge pipe / OS injection
          if (pid === undefined) {
            sendToClient(ws, {
              type: 'terminal:error',
              sessionId: ovrId,
              message: `No PTY and no PID found for session ${ovrId}`,
            });
            return;
          }
          // Try bridge pipe first, fall back to macOS Terminal / ConPTY injection
          (stateManager.isBridge(claudeSessionId)
            ? injectViaPipe(claudeSessionId, data).then(async (ok): Promise<void> => { if (!ok) await (process.platform === 'darwin' ? injectViaMac(pid, data, false) : injectText(pid, data, false, true)); })
            : process.platform === 'darwin' ? injectViaMac(pid, data, false) : injectText(pid, data, false, true).then(() => {})
          ).catch((err: Error) => {
              sendToClient(ws, {
                type: 'terminal:error',
                sessionId: ovrId,
                message: err.message,
              });
            });
        }
        return;
      }

      if (type === 'terminal:inject') {
        const ovrId = String(msg.sessionId ?? '');
        const text = String(msg.text ?? '');
        const extraEnter = Boolean(msg.extraEnter);
        // Resolve Claude session for bridge/PID info (fallback: treat ovrId as claudeId)
        const claudeSession = stateManager.getActiveClaudeByOvr(ovrId) ?? stateManager.getSession(ovrId);
        const claudeSessionId = claudeSession?.sessionId ?? ovrId;
        const targetPid = claudeSession?.pid;
        stateManager.clearHintOnInput(claudeSessionId);

        if (targetPid === undefined) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ovrId,
            message: `Session ${ovrId} not found`,
          });
          return;
        }

        const isBridge = stateManager.isBridge(claudeSessionId);
        const sessionType = claudeSession?.sessionType;
        const ptyIdEarly = ovrToPty.get(ovrId);
        const hasLivePty = !!(ptyIdEarly && ptyManager.has(ptyIdEarly));

        // Embedded sessions live inside a node-pty child. CGEvent injection
        // cannot reach node-pty children (no GUI terminal in the parent chain),
        // so if the PTY link is gone — typically an orphan from a prior server
        // boot — bail early with an actionable error instead of letting
        // injectViaMac surface a misleading "Accessibility permission" failure.
        if (!isBridge && sessionType === 'embedded' && !hasLivePty) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ovrId,
            message:
              `This embedded session is not linked to a live PTY (likely an orphan from a prior server boot). ` +
              `Kill the stale claude process (kill ${targetPid}) and resume the session.`,
          });
          return;
        }

        // Mark pending clear so the replacement transcript gets linked to this session
        if (text.trimStart().startsWith('/clear')) {
          stateManager.clearActivityFeed(claudeSessionId);
          const sess = stateManager.getSession(claudeSessionId);
          if (sess) stateManager.markPendingClearReplacement(claudeSessionId, sess.cwd);
        }

        // macOS/ConPTY fallback for non-PTY paths (also used as PTY fallback below).
        const macOrConsole = (t: string, ee: boolean): Promise<void> =>
          process.platform === 'darwin'
            ? injectViaMac(targetPid, t, ee).then(() => {})
            : injectText(targetPid, t, ee).then(() => {});

        // Prefer PTY stdin write when an active PTY is linked to this ovrId.
        // Writing directly to the TTY is more reliable than ConPTY virtual keystroke
        // injection and ensures text+Enter always reaches the process atomically.
        // Bridge sessions must NOT take this path — their PTY is a display mirror only;
        // input must go through the named pipe instead.
        const ptyId = ovrToPty.get(ovrId);
        if (!isBridge && ptyId && ptyManager.has(ptyId)) {
          console.log(`[inject] pty ovrId=${ovrId.slice(0, 8)} ptyId=${ptyId.slice(0, 8)} text="${text}"`);
          const ptyWrite = (data: string): boolean => {
            console.log(`[inject] pty write bytes=${data.length} ends=${JSON.stringify(data.slice(-2))} ovrId=${ovrId.slice(0, 8)}`);
            try { return ptyManager.write(ptyId, data); } catch { return false; }
          };
          scheduleInject(
            ptyWrite,
            () => ptyManager.has(ptyId),
            (data, initial) => {
              console.log(`[inject] pty ${initial ? 'initial' : 'deferred \\r'} failed, falling back to OS inject ovrId=${ovrId.slice(0, 8)}`);
              macOrConsole(data, initial ? extraEnter : false).catch((err: Error) => {
                if (initial) sendToClient(ws, { type: 'terminal:error', sessionId: ovrId, message: err.message });
              });
            },
            text,
            extraEnter,
          );
          return;
        }

        console.log(`[inject] ovrId=${ovrId.slice(0, 8)} claudeId=${claudeSessionId.slice(0, 8)} pid=${targetPid} text="${text}" bridge=${isBridge}`);
        // Try bridge pipe first, fall back to macOS Terminal.app injection, then ConPTY.
        (isBridge
          ? scheduleBridgeInject(
              (data) => injectViaPipe(claudeSessionId, data),
              (t, ee) => {
                console.log(`[inject] bridge pipe failed, falling back to OS inject ovrId=${ovrId.slice(0, 8)}`);
                return macOrConsole(t, ee);
              },
              () => {
                console.log(`[inject] bridge deferred \\r failed, sending Enter via OS inject ovrId=${ovrId.slice(0, 8)}`);
                return macOrConsole('\r', false);
              },
              text,
              extraEnter,
            )
          : macOrConsole(text, extraEnter)
        ).then(() => console.log(`[inject] ok pid=${targetPid}`))
          .catch((err: Error) => {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ovrId,
            message: err.message,
          });
        });
        return;
      }

      if (type === 'terminal:resize') {
        const ovrId = String(msg.sessionId ?? '');
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const claudeSession = stateManager.getActiveClaudeByOvr(ovrId) ?? stateManager.getSession(ovrId);
        const claudeSessionId = claudeSession?.sessionId ?? ovrId;
        if (stateManager.isBridge(claudeSessionId)) {
          void resizeAndNudgeBridgePipe(claudeSessionId, cols, rows);
        } else {
          const ptyId = ovrToPty.get(ovrId);
          ptyManager.resize(ptyId ?? ovrId, cols, rows);
        }
        return;
      }

      if (type === 'terminal:replay') {
        // Client requests replay of buffered output (e.g. after terminal remount on view switch)
        const ovrId = String(msg.sessionId ?? '');
        const claudeSession = stateManager.getActiveClaudeByOvr(ovrId) ?? stateManager.getSession(ovrId);
        const claudeSessionId = claudeSession?.sessionId ?? ovrId;
        // replay is sent whenever an xterm mounts — treat it as the output
        // subscription. Subscribe both ids to cover emit sites that fall back
        // to the claude sessionId when the overlordId lookup misses.
        subscribeTerminal(ws, ovrId);
        subscribeTerminal(ws, claudeSessionId);

        // Bridge sessions: send buffered output first for immediate display. Only replay
        // from the last BSU (\x1b[?2026h) chunk onward — that's a coherent frame boundary.
        // When the TUI is mid-work without BSUs, the buffer may hold hundreds of chunks of
        // streamed tool output; concat'ing them all makes xterm write every partial frame
        // and feels like scrolling. SIGWINCH below produces the next full frame.
        if (stateManager.isBridge(claudeSessionId)) {
          const cols = Number(msg.cols || 0);
          const rows = Number(msg.rows || 0);
          // Bridge buffer may be keyed by ovrId or claudeSessionId
          const buf = ptyOutputBuffer.get(ovrId) ?? ptyOutputBuffer.get(claudeSessionId);
          const slice = sliceBufferFromLastBsu(buf);
          if (slice.length > 0) {
            const encoded = Buffer.concat(slice).toString('base64');
            sendToClient(ws, { type: 'terminal:output', sessionId: ovrId, data: encoded });
          }
          console.log(`[terminal:replay] bridge nudge for ovrId=${ovrId.slice(0, 8)} cols=${cols} rows=${rows} bufChunks=${buf?.length ?? 0} sliceChunks=${slice.length}`);
          if (cols > 0 && rows > 0) {
            void resizeAndNudgeBridgePipe(claudeSessionId, cols, rows).then(ok => {
              console.log(`[terminal:replay] nudge result: ${ok ? 'ok' : 'FAILED'} for ovrId=${ovrId.slice(0, 8)}`);
            });
          } else {
            void nudgeBridgePipe(claudeSessionId).then(ok => {
              console.log(`[terminal:replay] nudge result: ${ok ? 'ok' : 'FAILED'} for ovrId=${ovrId.slice(0, 8)}`);
            });
          }
          return;
        }

        // Non-bridge PTY: send buffered output, then nudge the PTY with SIGWINCH so the
        // TUI repaints.
        const ptySessionId = ovrToPty.get(ovrId);
        const nudgeId = ptySessionId ?? (ptyManager.has(ovrId) ? ovrId : null);
        // Buffer: keyed by ptyId while alive, keyed by ovrId after exit
        const buf = ptyOutputBuffer.get(ptySessionId ?? '') ?? ptyOutputBuffer.get(ovrId);
        const cols = Number(msg.cols || 0);
        const rows = Number(msg.rows || 0);
        const isRaw = claudeSession?.sessionType === 'raw';
        // For non-raw TUIs, only replay from the last BSU chunk (coherent frame start).
        // Raw shells have no BSU, so keep the full-buffer replay (line output is idempotent).
        let replaySlice = isRaw ? (buf ?? []) : sliceBufferFromLastBsu(buf);
        // Fallback: if no BSU has been emitted yet (e.g. claude --resume that
        // hasn't reached its first synchronized frame), but the buffer holds
        // chunks, send the tail anyway. Worst case = a brief unframed paint;
        // current behavior = blank xterm forever when the TUI is frozen.
        if (!isRaw && replaySlice.length === 0 && buf && buf.length > 0) {
          replaySlice = buf.slice(Math.max(0, buf.length - 32));
        }
        console.log(`[terminal:replay] pty ovrId=${ovrId.slice(0, 8)} ptyId=${ptySessionId?.slice(0, 8) ?? 'none'} nudgeId=${nudgeId?.slice(0, 8) ?? 'none'} bufChunks=${buf?.length ?? 0} sliceChunks=${replaySlice.length} cols=${cols} rows=${rows} raw=${isRaw}`);
        // Raw sessions with a disk log: replay from disk when no live buffer is available.
        // This covers both historyOnly revived sessions and fresh reconnects where the
        // in-memory ring buffer was lost across a server restart.
        if (isRaw && replaySlice.length === 0 && hasShellHistory(ovrId)) {
          const diskLog = readShellHistory(ovrId);
          const banner = claudeSession?.historyOnly
            ? `\r\n\x1b[2m── restored shell history · ${new Date().toISOString()} · click "Restart shell" to start a live session ──\x1b[0m\r\n`
            : `\r\n\x1b[2m── restored shell history · ${new Date().toISOString()} ──\x1b[0m\r\n`;
          const payload = Buffer.concat([diskLog, Buffer.from(banner)]).toString('base64');
          sendToClient(ws, { type: 'terminal:history-dump', sessionId: ovrId, data: payload });
        } else if (replaySlice.length > 0) {
          const encoded = Buffer.concat(replaySlice).toString('base64');
          sendToClient(ws, { type: 'terminal:output', sessionId: ovrId, data: encoded });
        }
        // SIGWINCH nudge: causes the TUI to emit a fresh full-screen repaint.
        // Raw shells have no TUI — a SIGWINCH makes bash/zsh re-print the prompt,
        // which duplicates in scrollback on every replay. Skip nudge for raw;
        // explicit terminal:resize still resizes the PTY when xterm dims change.
        if (nudgeId && !isRaw) {
          ptyManager.resize(nudgeId, cols > 0 ? cols : 80, rows > 0 ? rows : 24);
          console.log(`[terminal:replay] nudged ${nudgeId.slice(0, 8)}`);
        }
        return;
      }

      if (type === 'terminal:kill') {
        const ovrId = String(msg.sessionId ?? '');
        const ptyId = ovrToPty.get(ovrId) ?? ovrId;
        // Get the PID before killing so we can find the Claude session record
        const ptyPid = ptyManager.getPid(ptyId);
        ptyManager.kill(ptyId);
        // Clean up ovrId ↔ ptyId maps (kill() bypasses the onExit handler)
        ptyToOvr.delete(ptyId);
        ovrToPty.delete(ovrId);
        const sessions = wsSessionMap.get(ws);
        if (sessions) { sessions.delete(ovrId); sessions.delete(ptyId); }

        // Find the real Claude session by PID and delete it
        if (ptyPid) {
          const target = stateManager.findLiveSessionByPid(ptyPid);
          if (target) deleteSession(target.sessionId, ptyPid, 'terminal:kill');
        }
        return;
      }

      if (type === 'terminal:focus') {
        const ovrId = String(msg.sessionId ?? '');
        const claudeSession = stateManager.getActiveClaudeByOvr(ovrId) ?? stateManager.getSession(ovrId);
        const tty = claudeSession?.bridgeTty;
        if (tty) {
          void focusBridgeWindow(tty);
        }
        return;
      }

      if (type === 'session:delete') {
        const sessionId = String(msg.sessionId ?? '');
        const targetPid = stateManager.getSession(sessionId)?.pid;
        deleteSession(sessionId, targetPid, 'session:delete (UI)');
        return;
      }

      if (type === 'session:close') {
        const sessionId = String(msg.sessionId ?? '');
        stateManager.markClosed(sessionId);
        return;
      }

      if (type === 'session:clone') {
        const sessionId = String(msg.sessionId ?? '');
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const targetSession = stateManager.getSession(sessionId);
        if (targetSession?.provider === 'opencode') {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId,
            message: 'OpenCode clone is not supported yet.',
          });
          return;
        }

        // Determine clone name (drift-proof names from sessionStore via stateManager)
        const liveSessions = stateManager.listLiveSessions();
        const original = stateManager.getSession(sessionId);
        let originalName = original ? (stateManager.getProjectedProposedName(original) ?? '') : '';
        let originalCwd = original?.cwd ?? '';

        // Fall back to archive entry (cloning a previously archived session)
        if (!originalCwd) {
          const archived = archiveManager.get(sessionId);
          if (archived) {
            originalName = originalName || archived.name;
            originalCwd = archived.cwd;
          }
        }

        const cwd = originalCwd || process.cwd();

        let cloneName: string;
        if (!originalName) {
          cloneName = 'Clone (1)';
        } else {
          const pattern = new RegExp(`^${originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+)\\)$`);
          let maxN = 0;
          for (const s of liveSessions) {
            const name = stateManager.getProjectedProposedName(s) ?? '';
            const match = name.match(pattern);
            if (match) maxN = Math.max(maxN, parseInt(match[1], 10));
          }
          cloneName = `${originalName} (${maxN + 1})`;
        }

        // Clone via --fork-session: the CLI reads the original transcript for
        // conversation history and creates a new session ID for future writes.
        // Overlord shows the parent's conversation via the resumedFrom fallback
        // in stateManager (no transcript copying needed).

        const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Pre-mint ovrId — client selection sees only ovr-XXX.
        const ovrId = stateManager.mintReservedOvrId(ptySessionId);
        ovrToPty.set(ovrId, ptySessionId);
        ptyToOvr.set(ptySessionId, ovrId);

        stateManager.trackPendingPtySpawn(cwd);

        const sessions = wsSessionMap.get(ws);
        if (sessions) { sessions.add(ovrId); sessions.add(ptySessionId); }

        sendToClient(ws, { type: 'terminal:spawned', sessionId: ovrId, pid: 0 });

        // Store clone info (name + original session) so it gets applied after
        // the PTY links to the new forked session via PID matching.
        linkageTracker.trackCloneInfo(ptySessionId, { name: cloneName, originalSessionId: sessionId });

        try {
          ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', sessionId, '--fork-session', '--name', `${cloneName}___OVR:${ptySessionId}`]);
          // Reserve the clone's ovrId against the child PID. `--fork-session`
          // first writes an initial resume session (carrying the ___OVR marker,
          // linked normally), then on the first turn rewrites {pid}.json with a
          // NEW sid, a new startedAt, AND the marker dropped. PID is the only
          // stable key across that fork, so reserve by it now — addOrUpdate's
          // consumeReservedOvrIdForPid then re-attaches the fork to this clone's
          // lineage instead of minting a fresh ovr (orphan worker). Mirrors
          // autoResumeBootstrap's marker-dropped resume handling.
          const clonePid = ptyManager.getPid(ptySessionId);
          if (clonePid) stateManager.reserveOvrIdForPid(clonePid, ovrId);
          else ptyManager.once('pid-ready', (sid: string, p: number) => {
            if (sid === ptySessionId && p) stateManager.reserveOvrIdForPid(p, ovrId);
          });
          log('pty:started', 'PTY clone started (fork-session)', {
            sessionId: ovrId,
            sessionName: cloneName,
          });
        } catch (err) {
          linkageTracker.dropCloneInfo(ptySessionId);
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ptySessionId,
            message: `Clone failed: ${(err as Error).message}`,
          });
          return;
        }

        ws.send(JSON.stringify({ type: 'session:cloned', ptySessionId, name: cloneName }));
        log('info', `Cloned session → pty=${ptySessionId}`, { sessionId, sessionName: cloneName });
        return;
      }
    });

    ws.on('close', () => {
      // Don't kill PTY sessions on WS close — they should survive tab refreshes
      // and be reconnectable from other tabs. Only clean up the session map.
      wsSessionMap.delete(ws);
      wsVisible.delete(ws);
      recomputePolling();
    });
  });
}
