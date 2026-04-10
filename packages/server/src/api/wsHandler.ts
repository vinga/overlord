import * as fs from 'fs';
import type { WebSocket, WebSocketServer } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe, nudgeBridgePipe, resizeAndNudgeBridgePipe, getBridgePath } from '../pty/pipeInjector.js';
import { injectViaMac } from '../pty/macInjector.js';
import { log } from '../logger.js';

export interface WsHandlerContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ptyToClaudeId: Map<string, string>;
  claudeToPtyId: Map<string, string>;
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws: WebSocket; timestamp: number }>;
  pendingCloneInfo: Map<string, { name: string; originalSessionId: string }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  broadcastRaw: (msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void;
  openTerminalWindow: (cwd: string, command: string, title?: string, sessionId?: string, useBridge?: boolean) => Promise<void>;
  autoResumePtySessions: () => Promise<void>;
  getLogBuffer: () => unknown[];
  bridgeInjectQueue: Map<string, Array<{ text: string; resolve: () => void }>>;
}

export function setupWebSocketHandler(wss: WebSocketServer, ctx: WsHandlerContext): void {
  const {
    stateManager,
    ptyManager,
    wsSessionMap,
    ptyToClaudeId,
    claudeToPtyId,
    pendingPtyByPid,
    pendingPtyByResumeId,
    pendingCloneInfo,
    ptyOutputBuffer,
    broadcastRaw,
    sendToClient,
    deleteSession,
    openTerminalWindow,
    autoResumePtySessions,
    getLogBuffer,
    bridgeInjectQueue,
  } = ctx;

  let autoResumeTriggered = false;

  wss.on('connection', (ws) => {
    // Trigger auto-resume on the first client connection
    if (!autoResumeTriggered) {
      autoResumeTriggered = true;
      autoResumePtySessions().catch(err => console.warn('[auto-resume] error:', err));
    }

    // Register this client in the session map
    wsSessionMap.set(ws, new Set());

    const snapshot = stateManager.getSnapshot();
    ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }));
    ws.send(JSON.stringify({ type: 'log:history', entries: getLogBuffer() }));
    // Replay active PTY session links so the terminal tab shows on fresh connects / reloads
    const wsSessions = wsSessionMap.get(ws)!;
    for (const [claudeSessionId, ptySessionId] of claudeToPtyId) {
      if (!ptyManager.has(ptySessionId)) continue; // skip dead PTYs
      wsSessions.add(claudeSessionId);
      wsSessions.add(ptySessionId);
      sendToClient(ws, { type: 'terminal:linked', ptySessionId, claudeSessionId, replay: true });
      // Replay buffered PTY output so the terminal isn't blank on reconnect
      const buf = ptyOutputBuffer.get(ptySessionId);
      if (buf && buf.length > 0) {
        const encoded = Buffer.concat(buf).toString('base64');
        sendToClient(ws, { type: 'terminal:output', sessionId: claudeSessionId, data: encoded });
      }
    }
    // Replay active bridge session links (bridge sessions don't use ptyManager)
    for (const [bridgeSessionId] of Object.entries(stateManager.deriveBridgeRegistry())) {
      sendToClient(ws, { type: 'terminal:linked', ptySessionId: `bridge-${bridgeSessionId}`, claudeSessionId: bridgeSessionId, replay: true });
      // Don't send historical buffer — terminal:replay will trigger a fresh nudge instead
    }

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return; // ignore non-JSON
      }

      const { type } = msg;

      if (type === 'terminal:spawn') {
        const cwd = String(msg.cwd ?? process.cwd());
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        const name = msg.name ? String(msg.name) : undefined;

        // Auto-create directory if it doesn't exist
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
          console.log(`[spawn] created directory: ${cwd}`);
        }

        // Generate a unique sessionId for this PTY session
        const sessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        stateManager.trackPendingPtySpawn(cwd);

        const sessions = wsSessionMap.get(ws);
        if (sessions) sessions.add(sessionId);

        broadcastRaw({ type: 'terminal:spawned', sessionId, pid: 0 });
        // Spawn after notifying client of sessionId (pid will be 0 until we have it)
        try {
          // Embed ptySessionId as hidden marker in session name for reliable PTY linking
          // (ConPTY on Windows may give a wrapper PID that doesn't match claude.exe PID)
          // If the user provided a name, prepend it before the marker.
          const sessionName = name ? `${name}___OVR:${sessionId}` : `___OVR:${sessionId}`;
          ptyManager.spawn(sessionId, cwd, cols, rows, ['--name', sessionName]);
          log('pty:started', 'PTY session started', { sessionId, sessionName: name ?? sessionId.slice(0, 8) });
          // pid-ready event handler populates pendingPtyByPid asynchronously
        } catch (err) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId,
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
        const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        stateManager.trackPendingResume(cwd, resumeSessionId);
        // Use the session's own ID for --resume, NOT getRootSessionId().
        // getRootSessionId traces resumedFrom chain back to the original, which may
        // still be running — resuming an already-running session crashes the CLI.
        const resumedName = stateManager.getSession(resumeSessionId)?.proposedName ?? resumeSessionId.slice(0, 8);
        log('session:resumed', 'Session resumed', { sessionId: resumeSessionId, sessionName: resumedName });

        const sessions = wsSessionMap.get(ws);
        if (sessions) sessions.add(ptySessionId);

        sendToClient(ws, { type: 'terminal:spawned', sessionId: ptySessionId, pid: 0 });
        try {
          // Resume the session via --resume flag.
          // Embed ptySessionId as hidden marker for reliable PTY linking on ConPTY.
          ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', resumeSessionId, '--name', `___OVR:${ptySessionId}`]);
          const resumePtyName = stateManager.getSession(resumeSessionId)?.proposedName ?? resumeSessionId.slice(0, 8);
          log('pty:started', 'PTY session started', { sessionId: ptySessionId, sessionName: resumePtyName });

          // Track by resume session ID for ConPTY PID mismatch linking
          pendingPtyByResumeId.set(resumeSessionId, { ptySessionId, ws, timestamp: Date.now() });
        } catch (err) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId: ptySessionId,
            message: `Resume failed: ${(err as Error).message}`,
          });
        }
        return;
      }

      if (type === 'terminal:open-external') {
        const sessionId = String(msg.sessionId ?? '');
        const cwd = String(msg.cwd ?? process.cwd());
        const session = stateManager.getSession(sessionId);
        const sessionName = session?.proposedName ?? sessionId.slice(0, 8);
        console.log(`[open-external] sessionId=${sessionId} cwd=${cwd}`);
        stateManager.setSessionType(sessionId, 'plain');
        const safeName = sessionName.replace(/"/g, '');
        openTerminalWindow(cwd, `claude --resume ${sessionId} --name "${safeName}"`, `Claude: ${sessionName}`, sessionId)
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
        const sessionName = session?.proposedName ?? sessionId.slice(0, 8);
        const marker = sessionId.slice(0, 8);
        const safeName = sessionName.replace(/["\s]/g, '-');
        const bridgePath = getBridgePath();
        const command = `"${bridgePath}" --pipe overlord-${marker} -- claude --resume ${sessionId} --name ${safeName}___BRG:${marker}`;
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

        // Auto-create directory if it doesn't exist
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
          console.log(`[open-new] created directory: ${cwd}`);
        }

        const cwdName = name || cwd.split(/[\\/]/).pop() || 'New';
        const safeCwdName = cwdName.replace(/"/g, '');
        console.log(`[open-new] cwd=${cwd} name=${cwdName} mode=${mode ?? 'default'}`);
        openTerminalWindow(cwd, `claude --name "${safeCwdName}"`, `Claude: ${cwdName}`, undefined, mode !== 'plain')
          .then(() => sendToClient(ws, { type: 'terminal:new-opened' }))
          .catch((err) => sendToClient(ws, { type: 'terminal:error', message: `Failed to open terminal: ${(err as Error).message}` }));
        return;
      }

      if (type === 'terminal:input') {
        const sessionId = String(msg.sessionId ?? '');
        const data = String(msg.data ?? '');
        stateManager.clearHintOnInput(sessionId);
        const wrote = ptyManager.write(claudeToPtyId.get(sessionId) ?? sessionId, data);
        if (!wrote) {
          // No PTY session — fall back to ConPTY injection
          const snapshot = stateManager.getSnapshot();
          let pid: number | undefined;
          outer: for (const room of snapshot.rooms) {
            for (const session of room.sessions) {
              if (session.sessionId === sessionId) {
                pid = session.pid;
                break outer;
              }
            }
          }
          if (pid === undefined) {
            sendToClient(ws, {
              type: 'terminal:error',
              sessionId,
              message: `No PTY and no PID found for session ${sessionId}`,
            });
            return;
          }
          // Try bridge pipe first, fall back to macOS Terminal / ConPTY injection
          (stateManager.isBridge(sessionId)
            ? injectViaPipe(sessionId, data).then(ok => { if (!ok) return process.platform === 'darwin' ? injectViaMac(pid, data, false) : injectText(pid, data, false, true); })
            : process.platform === 'darwin' ? injectViaMac(pid, data, false) : injectText(pid, data, false, true)
          ).catch((err: Error) => {
              sendToClient(ws, {
                type: 'terminal:error',
                sessionId,
                message: err.message,
              });
            });
        }
        return;
      }

      if (type === 'terminal:inject') {
        const sessionId = String(msg.sessionId ?? '');
        const text = String(msg.text ?? '');
        const extraEnter = Boolean(msg.extraEnter);
        stateManager.clearHintOnInput(sessionId);

        // Find the PID from stateManager sessions
        const snapshot = stateManager.getSnapshot();
        let targetPid: number | undefined;
        outer: for (const room of snapshot.rooms) {
          for (const session of room.sessions) {
            if (session.sessionId === sessionId) {
              targetPid = session.pid;
              break outer;
            }
          }
        }

        if (targetPid === undefined) {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId,
            message: `Session ${sessionId} not found`,
          });
          return;
        }

        const isBridge = stateManager.isBridge(sessionId);
        // PTY: \r — line discipline converts it to newline for the app.
        // Bridge: relays to ConPTY, so \r is also correct.
        const ptyTextToSend = text + (extraEnter ? '\r' : '');
        const bridgeTextToSend = text + '\r';

        // Mark pending clear so the replacement transcript gets linked to this session
        if (text.trimStart().startsWith('/clear')) {
          stateManager.clearActivityFeed(sessionId);
          const sess = stateManager.getSession(sessionId);
          if (sess) stateManager.markPendingClearReplacement(sessionId, sess.cwd);
        }

        // Prefer PTY stdin write when an active PTY is linked to this claude session.
        // Writing directly to the TTY is more reliable than ConPTY virtual keystroke
        // injection and ensures text+Enter always reaches the process atomically.
        const ptyId = claudeToPtyId.get(sessionId);
        if (ptyId && ptyManager.has(ptyId)) {
          console.log(`[inject] pty session=${sessionId.slice(0, 8)} ptyId=${ptyId.slice(0, 8)} text="${text}"`);
          ptyManager.write(ptyId, ptyTextToSend);
          console.log(`[inject] pty write ok`);
          return;
        }

        console.log(`[inject] session=${sessionId.slice(0, 8)} pid=${targetPid} text="${text}" bridge=${isBridge}`);
        // Try bridge pipe first, fall back to macOS Terminal.app injection, then ConPTY.
        // bridgeTextToSend already includes \r — one Enter, no delay needed.
        (isBridge
          ? injectViaPipe(sessionId, bridgeTextToSend).then(ok => {
              if (!ok) return process.platform === 'darwin' ? injectViaMac(targetPid, text, extraEnter) : injectText(targetPid, text, extraEnter);
            })
          : process.platform === 'darwin'
            ? injectViaMac(targetPid, text, extraEnter)
            : injectText(targetPid, text, extraEnter)
        ).then(() => console.log(`[inject] ok pid=${targetPid}`))
          .catch((err: Error) => {
          sendToClient(ws, {
            type: 'terminal:error',
            sessionId,
            message: err.message,
          });
        });
        return;
      }

      if (type === 'terminal:resize') {
        const sessionId = String(msg.sessionId ?? '');
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);
        ptyManager.resize(claudeToPtyId.get(sessionId) ?? sessionId, cols, rows);
        return;
      }

      if (type === 'terminal:replay') {
        // Client requests replay of buffered output (e.g. after terminal remount on view switch)
        const sessionId = String(msg.sessionId ?? '');

        // Bridge sessions: stale buffer contains incremental frames that cause artifacts.
        // Clear the buffer, tell the client to reset xterm, then nudge the bridge for a
        // fresh full-screen repaint which flows through the live OUTPT channel.
        if (stateManager.isBridge(sessionId)) {
          ptyOutputBuffer.set(sessionId, []);
          sendToClient(ws, { type: 'terminal:clear', sessionId });
          const cols = Number(msg.cols || 0);
          const rows = Number(msg.rows || 0);
          console.log(`[terminal:replay] bridge nudge for ${sessionId.slice(0, 8)} cols=${cols} rows=${rows}`);
          if (cols > 0 && rows > 0) {
            void resizeAndNudgeBridgePipe(sessionId, cols, rows).then(ok => {
              console.log(`[terminal:replay] nudge result: ${ok ? 'ok' : 'FAILED'} for ${sessionId.slice(0, 8)}`);
            });
          } else {
            void nudgeBridgePipe(sessionId).then(ok => {
              console.log(`[terminal:replay] nudge result: ${ok ? 'ok' : 'FAILED'} for ${sessionId.slice(0, 8)}`);
            });
          }
          return;
        }

        // Non-bridge PTY: send buffered output, then nudge the PTY with SIGWINCH so the
        // TUI repaints. This ensures the terminal isn't blank even if the buffer is stale
        // or empty (same pattern as the bridge nudge above).
        const ptySessionId = claudeToPtyId.get(sessionId);
        const nudgeId = ptySessionId ?? (ptyManager.has(sessionId) ? sessionId : null);
        const buf = ptyOutputBuffer.get(ptySessionId ?? sessionId) ?? ptyOutputBuffer.get(sessionId);
        const cols = Number(msg.cols || 0);
        const rows = Number(msg.rows || 0);
        console.log(`[terminal:replay] pty sid=${sessionId.slice(0, 8)} ptyId=${ptySessionId?.slice(0, 8) ?? 'none'} nudgeId=${nudgeId?.slice(0, 8) ?? 'none'} bufChunks=${buf?.length ?? 0} cols=${cols} rows=${rows}`);
        if (buf && buf.length > 0) {
          const encoded = Buffer.concat(buf).toString('base64');
          sendToClient(ws, { type: 'terminal:output', sessionId, data: encoded });
        }
        // SIGWINCH nudge: causes the TUI to emit a fresh full-screen repaint
        if (nudgeId) {
          ptyManager.resize(nudgeId, cols > 0 ? cols : 80, rows > 0 ? rows : 24);
          console.log(`[terminal:replay] nudged ${nudgeId.slice(0, 8)}`);
        }
        return;
      }

      if (type === 'terminal:kill') {
        const sessionId = String(msg.sessionId ?? '');
        const resolvedId = claudeToPtyId.get(sessionId) ?? sessionId;
        // Get the PID before killing so we can find the Claude session record
        const ptyPid = ptyManager.getPid(resolvedId);
        ptyManager.kill(resolvedId);
        // Clean up PTY <-> Claude ID maps (kill() bypasses the onExit handler)
        const linkedClaude = ptyToClaudeId.get(resolvedId);
        if (linkedClaude) {
          claudeToPtyId.delete(linkedClaude);
        }
        ptyToClaudeId.delete(resolvedId);
        // Also clean the forward entry if sessionId was the Claude ID
        if (claudeToPtyId.has(sessionId)) {
          claudeToPtyId.delete(sessionId);
        }
        const sessions = wsSessionMap.get(ws);
        if (sessions) sessions.delete(sessionId);

        // Find the real Claude session by PID and delete it
        if (ptyPid) {
          const snap = stateManager.getSnapshot();
          for (const room of snap.rooms) {
            for (const session of room.sessions) {
              if (session.pid === ptyPid) {
                deleteSession(session.sessionId, ptyPid, 'terminal:kill');
                break;
              }
            }
          }
        }
        return;
      }

      if (type === 'session:delete') {
        const sessionId = String(msg.sessionId ?? '');

        // Find PID for this session
        const snap = stateManager.getSnapshot();
        let targetPid: number | undefined;
        outer2: for (const room of snap.rooms) {
          for (const session of room.sessions) {
            if (session.sessionId === sessionId) { targetPid = session.pid; break outer2; }
          }
        }

        deleteSession(sessionId, targetPid, 'session:delete (UI)');
        return;
      }

      if (type === 'session:clone') {
        const sessionId = String(msg.sessionId ?? '');
        const cols = Number(msg.cols ?? 80);
        const rows = Number(msg.rows ?? 24);

        // Determine clone name
        const snap = stateManager.getSnapshot();
        let originalName = '';
        let originalCwd = '';
        for (const room of snap.rooms) {
          for (const session of room.sessions) {
            if (session.sessionId === sessionId) {
              originalName = session.proposedName ?? '';
              originalCwd = session.cwd;
              break;
            }
          }
          if (originalName) break;
        }

        const cwd = originalCwd || stateManager.getSession(sessionId)?.cwd || process.cwd();

        let cloneName: string;
        if (!originalName) {
          cloneName = 'Clone (1)';
        } else {
          const pattern = new RegExp(`^${originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+)\\)$`);
          let maxN = 0;
          for (const room of snap.rooms) {
            for (const session of room.sessions) {
              const match = (session.proposedName ?? '').match(pattern);
              if (match) {
                maxN = Math.max(maxN, parseInt(match[1], 10));
              }
            }
          }
          cloneName = `${originalName} (${maxN + 1})`;
        }

        // Clone via --fork-session: the CLI reads the original transcript for
        // conversation history and creates a new session ID for future writes.
        // Overlord shows the parent's conversation via the resumedFrom fallback
        // in stateManager (no transcript copying needed).

        const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        stateManager.trackPendingPtySpawn(cwd);

        const sessions = wsSessionMap.get(ws);
        if (sessions) sessions.add(ptySessionId);

        sendToClient(ws, { type: 'terminal:spawned', sessionId: ptySessionId, pid: 0 });

        // Store clone info (name + original session) so it gets applied after
        // the PTY links to the new forked session via PID matching.
        // This sets both proposedName and resumedFrom directly on the session,
        // bypassing the unreliable cwd-scoped pendingResumes mechanism.
        pendingCloneInfo.set(ptySessionId, { name: cloneName, originalSessionId: sessionId });

        try {
          ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', sessionId, '--fork-session', '--name', `${cloneName}___OVR:${ptySessionId}`]);
          log('pty:started', 'PTY clone started (fork-session)', {
            sessionId: ptySessionId,
            sessionName: cloneName,
          });
        } catch (err) {
          pendingCloneInfo.delete(ptySessionId);
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
    });
  });
}
