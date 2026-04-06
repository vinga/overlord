import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import { execSync, spawn } from 'child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { StateManager } from './session/stateManager.js';
import { SessionWatcher } from './session/sessionWatcher.js';
import { ProcessChecker } from './session/processChecker.js';
import { PtyManager } from './pty/ptyManager.js';
import { getBridgePath, getPipeName, bridgeManager, injectViaPipe, resizeAndNudgeBridgePipe } from './pty/pipeInjector.js';
import { startPermissionChecker } from './session/permissionChecker.js';
import { findTranscriptPathAnywhere } from './session/transcriptReader.js';
import { initLogger, log, getBuffer } from './logger.js';
import { AiClassifier } from './ai/aiClassifier.js';
import { registerApiRoutes } from './api/apiRoutes.js';
import { registerSessionEventHandlers } from './session/sessionEventHandlers.js';
import type { SessionEventContext } from './session/sessionEventHandlers.js';
import { setupWebSocketHandler } from './api/wsHandler.js';
import { startTranscriptWatcher } from './session/transcriptWatcher.js';
import { wirePtyEvents } from './pty/ptyEvents.js';
import type { OfficeSnapshot } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3000;

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Serve static files from client/dist in production
const clientDist = join(__dirname, '..', '..', '..', 'client', 'dist');
app.use(express.static(clientDist));

// PTY session manager
const ptyManager = new PtyManager();

// Track which WebSocket client owns which PTY sessions: ws → Set<sessionId>
const wsSessionMap = new Map<WebSocket, Set<string>>();

// Track pending PTY sessions by PID so we can link them to real Claude sessions
const pendingPtyByPid = new Map<number, { ptySessionId: string; ws: WebSocket }>();

// Track PTY sessions waiting to be linked by resumeSessionId (for ConPTY PID mismatch on Windows)
const pendingPtyByResumeId = new Map<string, { ptySessionId: string; ws: WebSocket; timestamp: number }>();

// Map pty-xxx sessionId → real claudeSessionId after linking
const ptyToClaudeId = new Map<string, string>();
// Reverse: claudeSessionId → pty-xxx sessionId (for input/resize routing)
const claudeToPtyId = new Map<string, string>();

// Ring buffer for PTY output — replayed on new WS connections so the terminal isn't blank
const ptyOutputBuffer = new Map<string, Buffer[]>();
const PTY_BUFFER_MAX_CHUNKS = 500;

// Rolling text buffer for bridge permission detection (last 8KB per session, plain text after ANSI strip)
const bridgePermText = new Map<string, string>();
const BRIDGE_PERM_BUF_SIZE = 8192;

function stripAnsi(raw: string): string {
  const stripped = raw
    // CSI sequences: ESC [ ... final-byte  (covers [?2026h, [0m, [2J, etc.)
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... ST or BEL
    .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
    // Other ESC + single char
    .replace(/\x1b[^[\]]/g, '')
    // Strip remaining bare ESC
    .replace(/\x1b/g, '')
    // Strip non-printable chars except newline/tab/CR
    .replace(/[^\x20-\x7e\n\t\r]/g, '');

  // Process carriage returns: \r moves to start of line, later content wins.
  // Find the last non-empty segment per newline-delimited chunk.
  return stripped.split('\n').map(line => {
    const parts = line.split('\r');
    // Work backwards to find the last non-empty segment (trailing \r gives empty string)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].trim()) return parts[i];
    }
    return parts[parts.length - 1];
  }).join('\n');
}

const BRIDGE_PERM_PRIMARY = /do you want to/i;
const BRIDGE_PERM_SECONDARY = [
  /esc to cancel/i,
  /yes,? (?:and )?allow .* (?:during|for) this session/i,
  /yes,? allow .* from this project/i,
];

function extractBridgePromptBlock(text: string): string {
  // Find the line containing "Do you want to" and take from there forward
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => /do you want to/i.test(l));
  if (startIdx === -1) return text.slice(-400);
  // Include up to 10 lines from the prompt (covers Yes/No options + Esc hint)
  return lines.slice(startIdx, startIdx + 10).join('\n').trim();
}

function checkBridgePermission(sessionId: string): void {
  const text = bridgePermText.get(sessionId) ?? '';
  const hasPrompt = BRIDGE_PERM_PRIMARY.test(text) && BRIDGE_PERM_SECONDARY.some(p => p.test(text));
  // stateManager available at call time (called from connectBridgePipe which runs after init)
  stateManager.setNeedsPermission(sessionId, hasPrompt, hasPrompt ? extractBridgePromptBlock(text) : undefined);
}

// Track recently removed sessions for CWD-based /clear detection (new PID case)
const recentlyRemovedByCwd = new Map<string, { sessionId: string; removedAt: number }>();

// Flag to skip clear detection during startup (loadKnownSessions + initial file scan)
let startupComplete = false;

// Map ptySessionId → clone name, applied after PTY is linked to a real Claude session
// Track pending clone info (name + original session) by ptySessionId.
// When the forked session links via PID, we apply the name and set resumedFrom
// so the transcript fallback in stateManager shows the parent's conversation.
const pendingCloneInfo = new Map<string, { name: string; originalSessionId: string }>();

// Track sessions opened via bridge (have named pipe for injection)
const bridgeSessions = new Set<string>();
// Tracks sessions currently mid-connection (async connect in progress).
// Prevents the session watcher and reconnectBridgePipes from both connecting.
const pendingBridgeConnect = new Set<string>();

// Persistent bridge pipe registry — survives server restarts
const BRIDGE_REGISTRY_PATH = join(os.tmpdir(), 'overlord-bridge-registry.json');

function loadBridgeRegistry(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_REGISTRY_PATH, 'utf-8'));
  } catch { return {}; }
}

function saveBridgeRegistry(registry: Record<string, string>): void {
  fs.writeFileSync(BRIDGE_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function registerBridgePipe(sessionId: string, pipeName: string): void {
  const reg = loadBridgeRegistry();
  reg[sessionId] = pipeName;
  saveBridgeRegistry(reg);
}

function unregisterBridgePipe(sessionId: string): void {
  const reg = loadBridgeRegistry();
  delete reg[sessionId];
  saveBridgeRegistry(reg);
}

// Pending bridge connections for new sessions (marker → temp pipe name)
// When a new session appears with ___BRG:<marker> in its name, we link it to the bridge pipe.
const pendingBridgeByMarker = new Map<string, { pipeName: string; timestamp: number }>();

// Bridge injection queue (kept for potential future use)
const bridgeInjectQueue = new Map<string, Array<{ text: string; resolve: () => void }>>();

// Helper: open a terminal window via overlord-bridge for reliable injection
async function openTerminalWindow(cwd: string, command: string, title?: string, sessionId?: string, useBridge: boolean = true): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const windowTitle = (title ?? 'Claude').replace(/"/g, '');
    const bridgePath = getBridgePath();
    const bridgeExists = useBridge && fs.existsSync(bridgePath);

    let fullCmd: string;
    if (bridgeExists) {
      // Use bridge for reliable named-pipe injection
      const pipeName = sessionId
        ? getPipeName(sessionId)
        : `overlord-new-${Date.now().toString(36)}`;
      const safeBridge = bridgePath.replace(/\//g, '\\');

      if (sessionId) {
        bridgeSessions.add(sessionId);
        bridgeManager.enableReconnect(sessionId);
        setTimeout(() => bridgeManager.connect(sessionId), 3000);
      } else {
        // Embed a unique marker in the command's --name flag for reliable matching
        const bridgeMarker = `brg-${Date.now().toString(36)}`;
        pendingBridgeByMarker.set(bridgeMarker, { pipeName, timestamp: Date.now() });
        command = command.replace(/--name "([^"]*)"/, `--name "$1___BRG:${bridgeMarker}"`);
      }

      // Run bridge directly (no cmd.exe /K) so it owns the console from row 0.
      fullCmd = `start "${windowTitle}" /D "${cwd}" ${safeBridge} --pipe ${pipeName} -- ${command}`;
      console.log(`[open-terminal] using bridge, pipe=${pipeName}`);
    } else {
      // Direct spawn — run command in a new terminal window.
      // If command starts with a quoted exe path, use start directly (no cmd.exe /K wrapper)
      // to avoid nested quote parsing issues. Otherwise wrap in cmd.exe /K.
      if (command.startsWith('"')) {
        fullCmd = `start "${windowTitle}" /D "${cwd}" ${command}`;
      } else {
        fullCmd = `start "${windowTitle}" /D "${cwd}" cmd.exe /K ${command}`;
      }
      console.log('[open-terminal] direct spawn');
    }

    console.log('[open-terminal] running:', fullCmd);
    const child = spawn(fullCmd, [], { shell: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.log('[open-terminal] error:', err.message);
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[open-terminal] success');
        resolve();
      } else {
        reject(new Error(`start exited with code ${code}`));
      }
    });
  });
}

// Connect to a bridge pipe for a given session. Used for both initial linking and reconnection.
// Opens TWO connections: one for reading output, one for writing input.
// This prevents output backpressure from blocking input delivery.
function connectBridgePipe(sessionId: string, pipeName: string): void {
  // Guard against concurrent calls (async connect in progress) and already-connected sessions
  if (bridgeManager.isConnected(sessionId) || pendingBridgeConnect.has(sessionId)) return;
  pendingBridgeConnect.add(sessionId);

  const pipeAddr = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : join(os.tmpdir(), `${pipeName}.sock`);

  bridgeSessions.add(sessionId);
  registerBridgePipe(sessionId, pipeName);
  // Store pipe addr immediately (synchronously) so nudge/resize one-shot connections
  // use the correct path even if terminal:replay arrives before the async connect fires.
  bridgeManager.setPipeAddr(sessionId, pipeAddr);

  // Connection 1: dedicated INPUT socket (for writing injections to the bridge)
  // Send "INPUT\n" handshake so bridge knows not to broadcast output to this socket
  const inputSocket = net.connect(pipeAddr, () => {
    inputSocket.write('INPUT\n', () => {
      console.log(`[bridge] input socket connected for ${sessionId.slice(0, 8)}`);
      pendingBridgeConnect.delete(sessionId); // connection established, unblock guard
      bridgeManager.registerSocket(sessionId, inputSocket, pipeAddr);
    });
  });

  let inputConnectFailed = false;
  inputSocket.on('error', (err: Error) => {
    console.log(`[bridge] input socket error for ${sessionId.slice(0, 8)}: ${err.message}`);
    pendingBridgeConnect.delete(sessionId);
    inputConnectFailed = true;
  });
  // Discard any data received on the input socket (output goes to the other socket)
  inputSocket.on('data', () => {});
  inputSocket.on('close', () => {
    bridgeManager.disconnect(sessionId);
    if (inputConnectFailed) {
      console.log(`[bridge] input pipe dead for ${sessionId.slice(0, 8)}, removing from registry`);
      bridgeSessions.delete(sessionId);
      unregisterBridgePipe(sessionId);
      bridgePermText.delete(sessionId);
    }
  });

  // Connection 2: dedicated OUTPUT socket (for reading ConPTY output from bridge)
  // Send "OUTPT\n" handshake so bridge adds this socket to the broadcast list
  const outputSocket = net.connect(pipeAddr, () => {
    outputSocket.write('OUTPT\n', () => {
      // Clear stale buffer — nudgeRedraw on the bridge side will immediately
      // produce a fresh full-screen repaint that fills the buffer from scratch.
      // Without this, replay sends historical output + redraw = garbled display.
      ptyOutputBuffer.delete(sessionId);
      console.log(`[bridge] output socket connected for ${sessionId.slice(0, 8)}`);
      broadcastRaw({ type: 'terminal:linked', ptySessionId: `bridge-${sessionId}`, claudeSessionId: sessionId });
      // The bridge auto-nudges at IntelliJ's terminal size (not Overlord's 120×30 xterm).
      // Tell clients to clear immediately, then send RSNUD after the wrong-size repaint
      // arrives so the ConPTY is resized before the next repaint.
      broadcastRaw({ type: 'terminal:clear', sessionId });
      setTimeout(() => {
        const pipeAddr = bridgeManager.getPipeAddr(sessionId);
        console.log(`[bridge] RSNUD: sending 120x30 to ${sessionId.slice(0, 8)} via ${pipeAddr}`);
        void resizeAndNudgeBridgePipe(sessionId, 120, 30).then(ok => {
          console.log(`[bridge] RSNUD result: ${ok ? 'ok' : 'failed'} for ${sessionId.slice(0, 8)}`);
        });
      }, 400);
    });
  });

  outputSocket.on('data', (data: Buffer) => {
    let buf = ptyOutputBuffer.get(sessionId);
    if (!buf) { buf = []; ptyOutputBuffer.set(sessionId, buf); }

    // \x1b[?2026h is the "synchronized output" start marker that Ink/React TUI
    // sends before every full-screen repaint. Use it as a checkpoint: discard
    // history so the replay buffer always begins at a complete, self-contained frame.
    // This prevents cursor-position-dependent incremental chunks from rendering
    // on top of unrelated history in a fresh xterm instance.
    if (data.includes(0x1b) && data.toString('binary').includes('\x1b[?2026h')) {
      buf = [];
      ptyOutputBuffer.set(sessionId, buf);
    }

    buf.push(data);
    if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);
    broadcastRaw({ type: 'terminal:output', sessionId, data: data.toString('base64') });

    // Update rolling plain-text buffer for permission detection
    const prev = bridgePermText.get(sessionId) ?? '';
    const appended = prev + stripAnsi(data.toString('utf8'));
    bridgePermText.set(sessionId, appended.length > BRIDGE_PERM_BUF_SIZE
      ? appended.slice(appended.length - BRIDGE_PERM_BUF_SIZE) : appended);
    checkBridgePermission(sessionId);
  });

  let outputConnectFailed = false;
  outputSocket.on('error', (err: Error) => {
    console.log(`[bridge] output socket error for ${sessionId.slice(0, 8)}: ${err.message}`);
    outputConnectFailed = true;
  });

  outputSocket.on('close', () => {
    if (outputConnectFailed) {
      console.log(`[bridge] output pipe dead for ${sessionId.slice(0, 8)}`);
    } else {
      console.log(`[bridge] output pipe disconnected for ${sessionId.slice(0, 8)}, will reconnect...`);
      setTimeout(() => connectBridgePipe(sessionId, pipeName), 2000);
    }
  });
}

// Called when a new session appears — check if its name contains a ___BRG: marker
function linkPendingBridge(sessionId: string, _cwd: string, rawName?: string): void {
  if (!rawName || !rawName.includes('___BRG:')) return;

  const marker = rawName.split('___BRG:')[1];
  if (!marker) return;

  if (bridgeSessions.has(sessionId)) return; // already connected

  const pending = pendingBridgeByMarker.get(marker);

  // Derive pipe name: Overlord-spawned sessions register a pending entry with the
  // exact pipe name; manually-started bridges use the convention overlord-<marker>.
  const pipeName = pending?.pipeName ?? `overlord-${marker}`;

  if (pending) {
    // Only match recent entries (< 30s)
    if (Date.now() - pending.timestamp > 30_000) {
      pendingBridgeByMarker.delete(marker);
      return;
    }
    pendingBridgeByMarker.delete(marker);
  }

  console.log(`[bridge] linking session ${sessionId.slice(0, 8)} to pipe ${pipeName} via marker ${marker}${pending ? '' : ' (manual spawn)'}`);
  stateManager.setSessionType(sessionId, 'bridge');
  connectBridgePipe(sessionId, pipeName);
}

// Reconnect to all known bridge pipes on startup
function reconnectBridgePipes(): void {
  const registry = loadBridgeRegistry();
  const entries = Object.entries(registry);
  if (entries.length === 0) return;
  console.log(`[bridge] reconnecting to ${entries.length} known bridge pipes...`);
  for (const [sessionId, pipeName] of entries) {
    // Try to connect — if bridge is dead, the error handler will clean up
    stateManager.setSessionType(sessionId, 'bridge');
    connectBridgePipe(sessionId, pipeName);
  }
}

// Helper: send a typed message to a specific client
function sendToClient(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Broadcast snapshot to all connected WS clients (wrapped with type field)
function broadcast(snapshot: OfficeSnapshot): void {
  broadcastRaw({ type: 'snapshot', ...snapshot });
}

// Broadcast an arbitrary typed message to all connected WS clients
function broadcastRaw(msg: object): void {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Wire up logger so it can broadcast log entries to all clients
initLogger((entry) => broadcastRaw({ type: 'log:entry', entry }));

// Setup state manager
const stateManager = new StateManager(() => {
  broadcast(stateManager.getSnapshot());
});

const aiClassifier = new AiClassifier(stateManager);

// Start permission checker (Windows-only; no-op on other platforms)
startPermissionChecker(stateManager);

// Shared context for session event handlers and transcript watcher
const sessionCtx: SessionEventContext = {
  stateManager,
  ptyManager,
  aiClassifier,
  wsSessionMap,
  ptyToClaudeId,
  claudeToPtyId,
  pendingPtyByPid,
  pendingPtyByResumeId,
  pendingCloneInfo,
  ptyOutputBuffer,
  recentlyRemovedByCwd,
  broadcastRaw,
  sendToClient,
  isStartupComplete: () => startupComplete,
  linkPendingBridge,
};

// Setup session watcher
const sessionWatcher = new SessionWatcher();
registerSessionEventHandlers(sessionWatcher, sessionCtx);
sessionWatcher.start();
startupComplete = true;

// Reconnect to any bridge pipes that survived the server restart
reconnectBridgePipes();

// Load closed sessions from transcripts on startup
stateManager.loadClosedSessionsFromTranscripts().catch(err => {
  console.warn('[startup] failed to load closed sessions from transcripts:', err);
});

async function autoResumePtySessions(): Promise<void> {
  // Auto-resume disabled — sessions are no longer automatically resumed at startup.
  // The function is kept as a no-op so callers don't need to be updated.
  console.log('[auto-resume] disabled — skipping');
  return;
}
// auto-resume is now triggered on first client WebSocket connection (see wss.on('connection'))

// Setup process checker
const processChecker = new ProcessChecker();
processChecker.start((pids) => {
  stateManager.updateAlivePids(pids);
});

// Transcript watcher + state refresh (moved to transcriptWatcher.ts)
startTranscriptWatcher({
  stateManager,
  ptyManager,
  aiClassifier,
  sessionCtx,
  broadcastRaw,
  pendingPtyByPid,
  pendingPtyByResumeId,
});

// PTY event handlers (moved to ptyEvents.ts)
wirePtyEvents({
  ptyManager,
  wsSessionMap,
  ptyToClaudeId,
  claudeToPtyId,
  pendingPtyByPid,
  pendingPtyByResumeId,
  ptyOutputBuffer,
  PTY_BUFFER_MAX_CHUNKS,
  broadcastRaw,
  sendToClient,
});

// Bridge pipe events → broadcast to clients (same flow as PTY output)
bridgeManager.on('connected', (sessionId: string) => {
  console.log(`[bridge] connected event for ${sessionId.slice(0, 8)}, broadcasting terminal:linked`);
  broadcastRaw({ type: 'terminal:linked', ptySessionId: `bridge-${sessionId}`, claudeSessionId: sessionId });
});

bridgeManager.on('output', (sessionId: string, data: Buffer) => {
  // Buffer for replay on reconnect
  let buf = ptyOutputBuffer.get(sessionId);
  if (!buf) { buf = []; ptyOutputBuffer.set(sessionId, buf); }
  buf.push(data);
  if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);

  const encoded = data.toString('base64');
  broadcastRaw({ type: 'terminal:output', sessionId, data: encoded });
});

bridgeManager.on('disconnected', (sessionId: string) => {
  // Don't remove from bridgeSessions — the bridge terminal window is still alive,
  // the pipe will reconnect. Only remove when session is explicitly closed/deleted.
  console.log(`[bridge] disconnected from ${sessionId.slice(0, 8)}, will reconnect`);
});

// Shared helper: kill a Claude session by PID and remove its session file + state
function deleteSession(sessionId: string, pid?: number, reason?: string): void {
  const caller = reason ?? new Error().stack?.split('\n')[2]?.trim() ?? 'unknown';
  log('session:killed', `Session deleted (${caller})`, { sessionId, sessionName: sessionId.slice(0, 8), extra: pid ? `PID ${pid}` : 'no PID' });
  console.log(`[deleteSession] sessionId=${sessionId} pid=${pid} reason=${caller}`);
  // 1. Kill the process tree so it can't recreate the session file
  if (pid) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[deleteSession] killed pid=${pid} via taskkill`);
    } catch {
      // Process already dead — fine
    }
  }

  // 2. Delete the session file
  const sessionFile = join(os.homedir(), '.claude', 'sessions', `${sessionId}.json`);
  try {
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log(`[deleteSession] deleted ${sessionFile}`);
    }
  } catch (err) {
    console.warn(`[deleteSession] failed to delete file for ${sessionId}:`, (err as Error).message);
  }

  // 3. Delete the transcript .jsonl file so it won't be reloaded by loadClosedSessionsFromTranscripts on restart
  const transcriptFile = findTranscriptPathAnywhere(sessionId);
  if (transcriptFile) {
    try {
      fs.unlinkSync(transcriptFile);
      console.log(`[deleteSession] deleted transcript ${transcriptFile}`);
    } catch (err) {
      console.warn(`[deleteSession] failed to delete transcript for ${sessionId}:`, (err as Error).message);
    }
  }

  // 3b. Delete the {sessionId}/ subdirectory under every slug in ~/.claude/projects/
  //     This holds subagent files (subagents/agent-*.jsonl) and any other per-session artifacts.
  //     Without this, a server restart would reload the session from leftover subagent transcripts.
  try {
    const projectsBase = join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(projectsBase)) {
      for (const slug of fs.readdirSync(projectsBase)) {
        const sessionSubdir = join(projectsBase, slug, sessionId);
        if (fs.existsSync(sessionSubdir)) {
          fs.rmSync(sessionSubdir, { recursive: true, force: true });
          console.log(`[deleteSession] deleted subdir ${sessionSubdir}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[deleteSession] failed to delete session subdir for ${sessionId}:`, (err as Error).message);
  }

  // 4. Delete task storage files so persisted hints/summaries don't survive
  const tasksBase = join(os.homedir(), '.claude', 'overlord', 'tasks', sessionId);
  for (const ext of ['.json', '.hint']) {
    const p = `${tasksBase}${ext}`;
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[deleteSession] deleted task file ${p}`);
      }
    } catch (err) {
      console.warn(`[deleteSession] failed to delete task file ${p}:`, (err as Error).message);
    }
  }

  // 5. Add to persistent deleted blocklist so this session is never resurrected on restart
  stateManager.markDeleted(sessionId);
  console.log(`[deleteSession] marked ${sessionId} as deleted in blocklist`);

  // 6. Clean up PTY maps so stale entries don't replay on WS reconnect
  const ptyId = claudeToPtyId.get(sessionId);
  if (ptyId) {
    claudeToPtyId.delete(sessionId);
    ptyToClaudeId.delete(ptyId);
    ptyManager.kill(ptyId);
    console.log(`[deleteSession] cleaned up PTY maps for pty=${ptyId}`);
  }

  // 7. Always explicitly remove from state (don't rely on chokidar firing)
  stateManager.remove(sessionId);
  console.log(`[deleteSession] removed ${sessionId} from state`);
}

// WebSocket handler (moved to wsHandler.ts)
setupWebSocketHandler(wss, {
  stateManager,
  ptyManager,
  wsSessionMap,
  ptyToClaudeId,
  claudeToPtyId,
  pendingPtyByPid,
  pendingPtyByResumeId,
  pendingCloneInfo,
  ptyOutputBuffer,
  bridgeSessions,
  broadcastRaw,
  sendToClient,
  deleteSession,
  openTerminalWindow,
  autoResumePtySessions,
  getLogBuffer: getBuffer,
  bridgeInjectQueue,
});

// API routes (moved to apiRoutes.ts)
registerApiRoutes(
  app,
  stateManager,
  ptyManager,
  { ptyToClaudeId, claudeToPtyId, pendingPtyByPid, pendingPtyByResumeId, pendingCloneInfo },
  bridgeSessions,
  deleteSession,
  aiClassifier.generateCompletionSummary.bind(aiClassifier),
  ptyOutputBuffer,
);

// Start HTTP server
httpServer.listen(PORT, () => {
  console.log(`Overlord server listening on http://localhost:${PORT}`);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[server] Port 3000 busy — killing old process and retrying...');
    try {
      execSync(
        'powershell -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"',
        { stdio: 'ignore' }
      );
    } catch (_) { /* ignore */ }
    httpServer.listen(PORT);
  } else {
    throw err;
  }
});

function shutdown() {
  wss.clients.forEach(client => client.terminate());
  wss.close();
  httpServer.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

