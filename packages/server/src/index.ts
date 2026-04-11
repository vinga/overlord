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
import { CodexSessionWatcher } from './session/codexSessionWatcher.js';
import { ProcessChecker } from './session/processChecker.js';
import { PtyManager } from './pty/ptyManager.js';
import { getBridgePath, getPipeName, bridgeManager, injectViaPipe, nudgeBridgePipe, resizeAndNudgeBridgePipe } from './pty/pipeInjector.js';
import { normalizePipeName, derivePipeNameFromMarker, resolvePipeName, computeIsReconnect } from './bridge/bridgeNameUtils.js';
import { startPermissionChecker } from './session/permissionChecker.js';
import { findTranscriptPathAnywhere } from './session/transcriptReader.js';
import { initLogger, log, getBuffer } from './logger.js';
import { AiClassifier } from './ai/aiClassifier.js';
import { registerApiRoutes } from './api/apiRoutes.js';
import { registerSessionEventHandlers, closeOrRemoveReplaced } from './session/sessionEventHandlers.js';
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

// When a bridge session is replaced (e.g. /clear), maps old sessionId → new sessionId.
// The existing output socket is closed over the old ID, so we reroute its output here.
const bridgeIdOverrides = new Map<string, string>();

// Track bridge sessions that have already been linked to the client at least once.
// Subsequent terminal:linked broadcasts (from reconnects) use replay:true so the client
// does not auto-select the session and steal OS focus.
const linkedBridgeSessions = new Set<string>();

// Rolling text buffer for bridge permission detection (last 8KB per session, plain text after ANSI strip)
const bridgePermText = new Map<string, string>();
const BRIDGE_PERM_BUF_SIZE = 8192;

// Last detected permission mode per bridge session — updated as text streams through
const bridgePermMode = new Map<string, string>();
// No >> prefix required — the (shift+tab to cycle) sentinel already ensures we're on the status bar line.
const BRIDGE_PERM_MODE_PATTERNS: Array<{ pattern: RegExp; mode: string }> = [
  { pattern: /bypass permissions on/i, mode: 'bypassPermissions' },
  { pattern: /accept edits on/i, mode: 'acceptEdits' },
  { pattern: /plan mode on/i, mode: 'plan' },
];

function stripAnsi(raw: string): string {
  const stripped = raw
    // CSI sequences: cursor-movement finals (A-H, S, T, f) → space to preserve word boundaries.
    // TUI status bars position text with cursor-absolute moves; without spaces the words concatenate.
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[A-HSTf]/g, ' ')
    // Remaining CSI sequences: ESC [ ... final-byte → nothing
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

// Flag to skip clear detection during startup (loadKnownSessions + initial file scan)
let startupComplete = false;

// Map ptySessionId → clone name, applied after PTY is linked to a real Claude session
// Track pending clone info (name + original session) by ptySessionId.
// When the forked session links via PID, we apply the name and set resumedFrom
// so the transcript fallback in stateManager shows the parent's conversation.
const pendingCloneInfo = new Map<string, { name: string; originalSessionId: string }>();

// Tracks sessions currently mid-connection (async connect in progress).
// Prevents the session watcher and reconnectBridgePipes from both connecting.
const pendingBridgeConnect = new Set<string>();

/** Migrate all bridge state from oldId to newId (used after /clear replacement). */
function migrateBridgeSession(oldId: string, newId: string): void {
  if (!stateManager.isBridge(oldId)) return;
  // Reroute output socket output (handler is closed over oldId)
  bridgeIdOverrides.set(oldId, newId);
  // Migrate input socket and pipe address
  bridgeManager.migrateSession(oldId, newId);
  // Registry migration is handled by stateManager.transferSessionState
  // Migrate buffered output and permission state
  const buf = ptyOutputBuffer.get(oldId);
  if (buf) { ptyOutputBuffer.set(newId, buf); ptyOutputBuffer.delete(oldId); }
  const pt = bridgePermText.get(oldId); if (pt) { bridgePermText.set(newId, pt); bridgePermText.delete(oldId); }
  const pm = bridgePermMode.get(oldId); if (pm) { bridgePermMode.set(newId, pm); bridgePermMode.delete(oldId); }
  if (linkedBridgeSessions.has(oldId)) { linkedBridgeSessions.add(newId); linkedBridgeSessions.delete(oldId); }
  // Tell clients the bridge terminal is now under newId
  broadcastRaw({ type: 'terminal:linked', ptySessionId: `bridge-${newId}`, claudeSessionId: newId, replay: true });
  // Nudge the bridge so the fresh screen state flows into newId's buffer before xterm mounts
  setTimeout(() => void nudgeBridgePipe(newId), 300);
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
    let pipeName: string | undefined;

    // Platform-independent bridge setup: configure pipe name and session state
    if (bridgeExists) {
      pipeName = sessionId
        ? getPipeName(sessionId)
        : `overlord-new-${Date.now().toString(36)}`;

      if (sessionId) {
        stateManager.setSessionType(sessionId, 'bridge');
        bridgeManager.enableReconnect(sessionId);
        setTimeout(() => bridgeManager.connect(sessionId), 3000);
      } else {
        // Embed a unique marker in the command's --name flag for reliable matching
        const bridgeMarker = `brg-${Date.now().toString(36)}`;
        pendingBridgeByMarker.set(bridgeMarker, { pipeName, timestamp: Date.now() });
        command = command.replace(/--name "([^"]*)"/, `--name "$1___BRG:${bridgeMarker}"`);
      }
    }

    let child: ReturnType<typeof spawn>;

    if (process.platform === 'darwin') {
      // macOS: build a bash command and run it in Terminal.app via osascript
      const safeCwd = cwd.replace(/"/g, '\\"');
      let bashCmd: string;
      if (bridgeExists && pipeName) {
        bashCmd = `cd "${safeCwd}" && "${bridgePath}" --pipe "${pipeName}" -- ${command}`;
        console.log(`[open-terminal] macOS bridge, pipe=${pipeName}`);
      } else {
        bashCmd = `cd "${safeCwd}" && ${command}`;
        console.log('[open-terminal] macOS direct');
      }
      // Escape double-quotes for embedding inside an AppleScript string literal
      const safeForAS = bashCmd.replace(/"/g, '\\"');
      // Open window, set it to a comfortable size (220×50), and bring Terminal to front
      const script = [
        'tell application "Terminal"',
        `  set w to do script "${safeForAS}"`,
        '  tell window 1',
        '    set number of columns to 160',
        '    set number of rows to 50',
        '  end tell',
        '  activate',
        'end tell',
      ].join('\n');
      console.log('[open-terminal] osascript:', script.split('\n')[0]);
      child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    } else {
      // Windows: use cmd.exe start command
      const safeBridge = bridgePath.replace(/\//g, '\\');
      let fullCmd: string;
      if (bridgeExists && pipeName) {
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
      child = spawn(fullCmd, [], { shell: true, stdio: 'ignore' });
    }

    child.on('error', (err) => {
      console.log('[open-terminal] error:', err.message);
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[open-terminal] success');
        resolve();
      } else {
        reject(new Error(`terminal open exited with code ${code}`));
      }
    });
  });
}

/**
 * Find the TTY device path of the terminal hosting a bridge session (macOS only).
 * Uses: claude PID → parent PID (bridge process) → ps tty.
 * Returns e.g. "/dev/ttys003", or "" on failure or non-macOS.
 *
 * Note: We intentionally do NOT use the GETTY pipe command here because old bridge
 * binaries (without GETTY support) would forward "GETTY\n" as text input to Claude.
 */
function queryBridgeTTY(claudePid: number | undefined): string {
  if (process.platform !== 'darwin' || !claudePid) return '';
  try {
    const ppidOut = execSync(`ps -o ppid= -p ${claudePid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    const bridgePid = parseInt(ppidOut);
    if (isNaN(bridgePid) || bridgePid <= 1) return '';
    const ttyOut = execSync(`ps -o tty= -p ${bridgePid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!ttyOut || ttyOut === '??' || ttyOut === '?') return '';
    return `/dev/${ttyOut}`;
  } catch { return ''; }
}

// Connect to a bridge pipe for a given session. Used for both initial linking and reconnection.
// Opens TWO connections: one for reading output, one for writing input.
// This prevents output backpressure from blocking input delivery.
function connectBridgePipe(sessionId: string, pipeName: string): void {
  // Normalise legacy "overlord-brg-{x}" pipe names to "overlord-new-{x}".
  // Normalize legacy pipe names (overlord-brg-{x} → overlord-new-{x})
  const normalized = normalizePipeName(pipeName);
  if (normalized !== pipeName) {
    pipeName = normalized;
    stateManager.setBridgePipe(sessionId, pipeName);
  }

  // Guard against concurrent calls (async connect in progress) and already-connected sessions
  if (bridgeManager.isConnected(sessionId) || pendingBridgeConnect.has(sessionId)) return;
  pendingBridgeConnect.add(sessionId);

  const pipeAddr = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : join(os.tmpdir(), `${pipeName}.sock`);

  // If another session is already connected to this pipe, disconnect it first.
  // This happens when a session is replaced (e.g., /clear) and the new session
  // picks up the same bridge marker → same pipe name.
  for (const [existingId] of Object.entries(stateManager.deriveBridgeRegistry())) {
    if (existingId !== sessionId && bridgeManager.getPipeAddr(existingId) === pipeAddr) {
      console.log(`[bridge] pipe collision: disconnecting stale ${existingId.slice(0, 8)} (replaced by ${sessionId.slice(0, 8)}) on ${pipeName}`);
      bridgeManager.disconnect(existingId);
      stateManager.setBridgePipe(existingId, '');
      bridgePermText.delete(existingId); bridgePermMode.delete(existingId);
    }
  }

  stateManager.setBridgePipe(sessionId, pipeName);
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
      // Revive sessions loaded as 'closed' from known-sessions on restart.
      // The bridge is alive → the process is still running → session is active again.
      stateManager.reviveClosedSession(sessionId);
      // Find the TTY of the Terminal.app tab hosting this bridge (macOS only).
      // Used later to bring the window to front via AppleScript.
      const claudePid = stateManager.getSession(sessionId)?.pid;
      const tty = queryBridgeTTY(claudePid);
      if (tty) {
        console.log(`[bridge] tty for ${sessionId.slice(0, 8)}: ${tty}`);
        stateManager.setBridgeTty(sessionId, tty);
      }
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
      console.log(`[bridge] input pipe dead for ${sessionId.slice(0, 8)}`);
      bridgePermText.delete(sessionId); bridgePermMode.delete(sessionId);
      // Don't clear bridgePipeName — it's metadata for reconnection, not a live indicator.
      // Don't markClosed — processChecker will handle that if the PID is truly dead.
    }
  });

  // Connection 2: dedicated OUTPUT socket — extracted to its own function so it can
  // self-reconnect independently of the input socket (the connectBridgePipe guard checks
  // bridgeManager.isConnected which only reflects the input socket; if the output socket
  // disconnects while the input is still alive, calling connectBridgePipe again would be
  // a no-op and the output socket would never come back).
  connectBridgeOutputSocket(sessionId, pipeAddr, pipeName);
}

function connectBridgeOutputSocket(sessionId: string, pipeAddr: string, pipeName: string): void {
  // Send "OUTPT\n" handshake so bridge adds this socket to the broadcast list
  const outputSocket = net.connect(pipeAddr, () => {
    outputSocket.write('OUTPT\n', () => {
      // Clear stale buffer — the bridge auto-nudges (SIGWINCH) when OUTPT connects,
      // producing a fresh full-screen repaint that fills the buffer from scratch.
      ptyOutputBuffer.delete(sessionId);
      console.log(`[bridge] output socket connected for ${sessionId.slice(0, 8)}`);
      const isOutputReconnect = computeIsReconnect(linkedBridgeSessions, sessionId);
      broadcastRaw({ type: 'terminal:linked', ptySessionId: `bridge-${sessionId}`, claudeSessionId: sessionId, ...(isOutputReconnect ? { replay: true } : {}) });
      // No server-side health check: idle sessions (blank prompt after /clear, waiting for input)
      // legitimately produce no output for long periods. Dead bridges are handled by:
      //   1. XtermTerminal client-side overlay (8s timeout with no content)
      //   2. processChecker — marks session closed when PID dies
      // Pin the pipe address to the one we just successfully connected to.
      bridgeManager.setPipeAddr(sessionId, pipeAddr);
    });
  });

  outputSocket.on('data', (data: Buffer) => {
    // Follow the override chain (supports multiple /clear cycles: A→B→C)
    let eid = sessionId;
    for (let i = 0; i < 10 && bridgeIdOverrides.has(eid); i++) eid = bridgeIdOverrides.get(eid)!;
    let buf = ptyOutputBuffer.get(eid);
    if (!buf) { buf = []; ptyOutputBuffer.set(eid, buf); }

    // \x1b[?2026h is the "synchronized output" start marker that Ink/React TUI
    // sends before every full-screen repaint. Use it as a checkpoint: discard
    // history so the replay buffer always begins at a complete, self-contained frame.
    // This prevents cursor-position-dependent incremental chunks from rendering
    // on top of unrelated history in a fresh xterm instance.
    const isRepaint = data.includes(0x1b) && data.toString('binary').includes('\x1b[?2026h');
    if (isRepaint) {
      buf = [];
      ptyOutputBuffer.set(eid, buf);
    }

    buf.push(data);
    if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);
    broadcastRaw({ type: 'terminal:output', sessionId: eid, data: data.toString('base64') });

    // Update rolling plain-text buffer for permission detection
    const prev = bridgePermText.get(eid) ?? '';
    const appended = prev + stripAnsi(data.toString('utf8'));
    bridgePermText.set(eid, appended.length > BRIDGE_PERM_BUF_SIZE
      ? appended.slice(appended.length - BRIDGE_PERM_BUF_SIZE) : appended);
    checkBridgePermission(eid);

    // Detect permission mode from the rolling text buffer tail.
    // Runs on every data event (not just repaints) so we catch the status bar even when
    // \x1b[?2026h (BSU) arrives in a different chunk than the status bar line.
    // Use "(shift+tab to cycle)" as the sentinel — it's the literal tail of every Claude
    // CLI status bar line and is far less likely to appear in terminal content than ">>".
    // Find the LAST such line and check if it contains a mode keyword.
    {
      const tail = (bridgePermText.get(eid) ?? '').slice(-2048);
      const tailLines = tail.split('\n');
      let detectedMode: string | undefined;
      let statusBarFound = false;
      for (let i = tailLines.length - 1; i >= 0; i--) {
        const line = tailLines[i];
        if (/\(shift\+tab to cycle\)/i.test(line)) {
          statusBarFound = true;
          for (const { pattern, mode } of BRIDGE_PERM_MODE_PATTERNS) {
            if (pattern.test(line)) { detectedMode = mode; break; }
          }
          // detectedMode stays undefined if default mode (no keyword in status bar)
          break;
        }
      }
      if (statusBarFound) {
        const resolvedMode = detectedMode ?? 'default';
        bridgePermMode.set(eid, resolvedMode);
        // Only reset to 'default' when session is at the interactive prompt (waiting).
        // During thinking/working, the full TUI may not be rendering the status bar.
        if (resolvedMode !== 'default' || stateManager.getSession(eid)?.state === 'waiting') {
          stateManager.setPermissionMode(eid, resolvedMode);
        }
      }
    }
  });

  let outputConnectFailed = false;
  outputSocket.on('error', (err: Error) => {
    console.log(`[bridge] output socket error for ${sessionId.slice(0, 8)}: ${err.message}`);
    outputConnectFailed = true;
  });

  outputSocket.on('close', () => {
    let currentId = sessionId;
    for (let i = 0; i < 10 && bridgeIdOverrides.has(currentId); i++) currentId = bridgeIdOverrides.get(currentId)!;
    if (!stateManager.isBridge(currentId)) return; // session gone, stop retrying
    if (outputConnectFailed) {
      // Pipe didn't exist yet (bridge not running) — retry after 3s in case it comes up.
      console.log(`[bridge] output pipe dead for ${sessionId.slice(0, 8)}, will retry...`);
      setTimeout(() => connectBridgeOutputSocket(sessionId, pipeAddr, pipeName), 3000);
    } else {
      // Clean disconnect — reconnect quickly.
      console.log(`[bridge] output pipe disconnected for ${sessionId.slice(0, 8)}, will reconnect...`);
      setTimeout(() => connectBridgeOutputSocket(sessionId, pipeAddr, pipeName), 2000);
    }
  });
}

// Called when a new session appears — check if its name contains a ___BRG: marker
function linkPendingBridge(sessionId: string, _cwd: string, rawName?: string): void {
  if (!rawName || !rawName.includes('___BRG:')) return;

  const marker = rawName.split('___BRG:')[1];
  if (!marker) return;

  if (bridgeManager.isConnected(sessionId)) return; // already connected

  const pending = pendingBridgeByMarker.get(marker);
  const pipeName = resolvePipeName(marker, pending, Date.now());
  if (!pipeName) {
    pendingBridgeByMarker.delete(marker);
    return;
  }
  if (pending) pendingBridgeByMarker.delete(marker);

  // If the session already has this exact pipe stored (e.g. restart race where
  // the session watcher fires before reconnectBridgePipes), connectBridgePipe's
  // own guard will handle deduplication. Never short-circuit to an existingPipe
  // that may be stale (e.g. from a previous bridge run with a different socket).
  console.log(`[bridge] linking session ${sessionId.slice(0, 8)} to pipe ${pipeName} via marker ${marker}${pending ? '' : ' (derived)'}`);
  stateManager.setSessionType(sessionId, 'bridge');
  connectBridgePipe(sessionId, pipeName);
}

// Reconnect to all known bridge pipes on startup
function reconnectBridgePipes(): void {
  const registry = stateManager.deriveBridgeRegistry();
  const entries = Object.entries(registry);
  if (entries.length === 0) return;

  console.log(`[bridge] reconnecting to ${entries.length} known bridge pipes...`);
  for (const [sessionId, pipeName] of entries) {
    // Skip already-connected sessions; attempt closed bridge sessions so reviveClosedSession() fires on success
    if (bridgeManager.isConnected(sessionId)) continue;
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

// Extract readable text from a raw terminal output buffer (last N chunks)
function bufferToText(chunks: Buffer[]): string | null {
  if (!chunks || chunks.length === 0) return null;
  return stripAnsi(Buffer.concat(chunks.slice(-50)).toString('utf8')).trim() || null;
}

// Screen text reader for permissionChecker — handles bridge, embedded PTY, and plain sessions
async function getScreenText(sessionId: string, pid: number): Promise<string | null> {
  // Bridge sessions: use ptyOutputBuffer (reset at each repaint start, rebuilt from all chunks).
  // This gives permissionChecker the most recent complete repaint frame.
  if (stateManager.isBridge(sessionId)) {
    return bufferToText(ptyOutputBuffer.get(sessionId) ?? []);
  }
  // Embedded PTY sessions: ptyOutputBuffer is keyed by the PTY session ID
  const ptyId = claudeToPtyId.get(sessionId);
  if (ptyId) {
    return bufferToText(ptyOutputBuffer.get(ptyId) ?? []);
  }
  // Plain/IDE sessions: try Windows console API
  const { readScreen } = await import('./pty/consoleInjector.js');
  return readScreen(pid);
}

// Start permission checker (Windows-only; no-op on other platforms)
// injectIntoSession: tries bridge pipe first, falls back to ConPTY injection
async function injectIntoSession(sessionId: string, text: string): Promise<void> {
  const session = stateManager.getSession(sessionId);
  if (!session) return;
  if (stateManager.isBridge(sessionId)) {
    const ok = await injectViaPipe(sessionId, text);
    if (ok) return;
  }
  const { injectText } = await import('./pty/consoleInjector.js');
  await injectText(session.pid, text, false);
}
startPermissionChecker(stateManager, getScreenText, injectIntoSession);

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
  migrateBridgeSession,
  broadcastRaw,
  sendToClient,
  isStartupComplete: () => startupComplete,
  linkPendingBridge,
};

// Setup session watcher
const sessionWatcher = new SessionWatcher();
const codexSessionWatcher = new CodexSessionWatcher();
registerSessionEventHandlers(sessionWatcher, sessionCtx);
registerSessionEventHandlers(codexSessionWatcher, sessionCtx);
sessionWatcher.start();
codexSessionWatcher.start();
startupComplete = true;

// Detect /clear that happened while server was down (PID file comparison)
stateManager.detectClearOnStartup();

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

setInterval(() => {
  stateManager.cleanupStaleSessions();
}, 60_000).unref();

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
  stateManager,
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
  const isReconnect = computeIsReconnect(linkedBridgeSessions, sessionId);
  console.log(`[bridge] connected event for ${sessionId.slice(0, 8)}, broadcasting terminal:linked${isReconnect ? ' (reconnect/replay)' : ''}`);
  broadcastRaw({ type: 'terminal:linked', ptySessionId: `bridge-${sessionId}`, claudeSessionId: sessionId, ...(isReconnect ? { replay: true } : {}) });
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
      try { execSync(`pkill -P ${pid}`, { stdio: 'ignore' }); } catch { /* no children */ }
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      console.log(`[deleteSession] killed pid=${pid} via kill -9`);
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

  // 6b. Clean up bridge state
  if (stateManager.isBridge(sessionId)) {
    bridgeManager.disconnect(sessionId);
    stateManager.setBridgePipe(sessionId, '');
    bridgePermText.delete(sessionId); bridgePermMode.delete(sessionId);
    linkedBridgeSessions.delete(sessionId);
    console.log(`[deleteSession] cleaned up bridge state for ${sessionId.slice(0, 8)}`);
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
  deleteSession,
  aiClassifier.generateCompletionSummary.bind(aiClassifier),
  ptyOutputBuffer,
  aiClassifier.generateTaskTitle.bind(aiClassifier),
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
