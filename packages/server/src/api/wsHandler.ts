import * as fs from 'fs';
import type { WebSocket, WebSocketServer } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe, nudgeBridgePipe, resizeAndNudgeBridgePipe, getBridgePath } from '../pty/pipeInjector.js';
import { injectViaMac } from '../pty/macInjector.js';
import { log } from '../logger.js';
import { focusBridgeWindow } from '../pty/windowFocus.js';
import { scheduleInject, scheduleBridgeInject } from '../pty/injectScheduler.js';
import { writeMeta as writeShellHistoryMeta, readAll as readShellHistory, hasLog as hasShellHistory } from '../pty/shellHistoryLog.js';
import { archiveManager } from '../archive/archiveManager.js';

export interface WsHandlerContext {
  stateManager: StateManager;
  ptyManager: PtyManager;
  wsSessionMap: Map<WebSocket, Set<string>>;
  ovrToPty: Map<string, string>;     // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;     // ptySessionId → ovrId
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws?: WebSocket; timestamp: number }>;
  pendingCloneInfo: Map<string, { name: string; originalSessionId: string }>;
  ptyOutputBuffer: Map<string, Buffer[]>;
  broadcastRaw: (msg: object) => void;
  sendToClient: (ws: WebSocket, msg: object) => void;
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void;
  openTerminalWindow: (cwd: string, command: string, title?: string, sessionId?: string, useBridge?: boolean) => Promise<void>;
  autoResumePtySessions: () => Promise<void>;
  getLogBuffer: () => unknown[];
}


function stripInternalMarkers(name: string): string {
  return name.replace(/___(?:BRG|OVR):[A-Za-z0-9_-]*/g, '').replace(/[-_\s]+$/, '').trim();
}

export function setupWebSocketHandler(wss: WebSocketServer, ctx: WsHandlerContext): void {
  const {
    stateManager,
    ptyManager,
    wsSessionMap,
    ovrToPty,
    ptyToOvr,
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
      // Replay buffered PTY output so the terminal isn't blank on reconnect.
      // Buffer is keyed by ptyId while alive (migrated to ovrId on exit).
      const buf = ptyOutputBuffer.get(ptySessionId) ?? ptyOutputBuffer.get(ovrId);
      if (buf && buf.length > 0) {
        const encoded = Buffer.concat(buf).toString('base64');
        sendToClient(ws, { type: 'terminal:output', sessionId: ovrId, data: encoded });
      }
    }
    // Replay active bridge session links (bridge sessions don't use ptyManager).
    // Bridge ovrId is stored on the session's overlordId field.
    for (const [bridgeSessionId] of Object.entries(stateManager.deriveBridgeRegistry())) {
      const bridgeSess = stateManager.getSession(bridgeSessionId);
      const bridgeOvrId = bridgeSess?.overlordId ?? bridgeSessionId;
      sendToClient(ws, { type: 'terminal:linked', ovrId: bridgeOvrId, ptySessionId: `bridge-${bridgeSessionId}`, claudeSessionId: bridgeSessionId, replay: true });
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

        // Pass the ptyId so stateManager can flag this as a fresh spawn and
        // skip the cwd-keyed pendingResumes lookup in addOrUpdate (which
        // would otherwise contaminate this fresh session with a stale
        // resume entry from another PTY in the same cwd).
        stateManager.trackPendingPtySpawn(cwd, sessionId);

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
        const sessionName = stripInternalMarkers(session?.proposedName ?? sessionId.slice(0, 8));
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
        const sessionName = stripInternalMarkers(session?.proposedName ?? sessionId.slice(0, 8));
        const marker = sessionId.slice(0, 8);
        const safeName = sessionName.replace(/"/g, '-');
        const bridgePath = getBridgePath();
        const command = `"${bridgePath}" --pipe overlord-${marker} -- claude --resume ${sessionId} --name "${safeName}___BRG:${marker}"`;
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

        // Bridge sessions: send buffered output first for immediate display (buffer is
        // trimmed to start at the last full repaint frame via \x1b[?2026h detection, so
        // replaying it is safe). Then nudge the bridge for a fresh repaint.
        if (stateManager.isBridge(claudeSessionId)) {
          const cols = Number(msg.cols || 0);
          const rows = Number(msg.rows || 0);
          // Bridge buffer may be keyed by ovrId or claudeSessionId
          const buf = ptyOutputBuffer.get(ovrId) ?? ptyOutputBuffer.get(claudeSessionId);
          if (buf && buf.length > 0) {
            const encoded = Buffer.concat(buf).toString('base64');
            sendToClient(ws, { type: 'terminal:output', sessionId: ovrId, data: encoded });
          }
          console.log(`[terminal:replay] bridge nudge for ovrId=${ovrId.slice(0, 8)} cols=${cols} rows=${rows} bufChunks=${buf?.length ?? 0}`);
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
        console.log(`[terminal:replay] pty ovrId=${ovrId.slice(0, 8)} ptyId=${ptySessionId?.slice(0, 8) ?? 'none'} nudgeId=${nudgeId?.slice(0, 8) ?? 'none'} bufChunks=${buf?.length ?? 0} cols=${cols} rows=${rows} raw=${isRaw}`);
        // Raw sessions with a disk log: replay from disk when no live buffer is available.
        // This covers both historyOnly revived sessions and fresh reconnects where the
        // in-memory ring buffer was lost across a server restart.
        if (isRaw && (!buf || buf.length === 0) && hasShellHistory(ovrId)) {
          const diskLog = readShellHistory(ovrId);
          const banner = claudeSession?.historyOnly
            ? `\r\n\x1b[2m── restored shell history · ${new Date().toISOString()} · click "Restart shell" to start a live session ──\x1b[0m\r\n`
            : `\r\n\x1b[2m── restored shell history · ${new Date().toISOString()} ──\x1b[0m\r\n`;
          const payload = Buffer.concat([diskLog, Buffer.from(banner)]).toString('base64');
          sendToClient(ws, { type: 'terminal:history-dump', sessionId: ovrId, data: payload });
        } else if (buf && buf.length > 0) {
          const encoded = Buffer.concat(buf).toString('base64');
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

        // Fall back to archive entry (cloning a previously archived session)
        if (!originalCwd) {
          const archived = archiveManager.get(sessionId);
          if (archived) {
            originalName = originalName || archived.name;
            originalCwd = archived.cwd;
          }
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
