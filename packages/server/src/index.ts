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
import { openTerminalWindow as openTerminalWindowImpl, queryBridgeTTY } from './pty/terminalLauncher.js';
import { deleteSession as deleteSessionImpl } from './session/sessionDeleter.js';
import { normalizePipeName, derivePipeNameFromMarker, resolvePipeName, computeIsReconnect } from './bridge/bridgeNameUtils.js';
import { startPermissionChecker } from './session/permissionChecker.js';
import { detectModeFromText } from './session/modeDetect.js';
import { findTranscriptPath } from './session/transcriptReader.js';
import { autoResumePtySessions as autoResumePtySessionsImpl } from './session/autoResumeBootstrap.js';
import { PtyLinkageTracker } from './session/ptyLinkageTracker.js';
import { initLogger, log, getBuffer } from './logger.js';
import { AiClassifier } from './ai/aiClassifier.js';
import { IntentSummarizer } from './ai/intentSummary.js';
import { killClaudeWorker } from './ai/claudeQuery.js';
import { sessionStore } from './session/sessionStore.js';
import { globalSettingsStore } from './session/globalSettingsStore.js';
import { writeLiveAtShutdown, consumeLiveAtShutdown, writeLivePtyHeartbeat, clearLivePtyHeartbeat, consumeLivePtyFallback, type LiveAtShutdownEntry, type LivePtyEntry } from './session/liveAtShutdownStore.js';
import { clearJiraTitleCache } from './session/jiraTitleCache.js';
import { artifactStore } from './artifacts/artifactStore.js';
import { ArtifactWatcher } from './artifacts/artifactWatcher.js';
import { registerApiRoutes } from './api/apiRoutes.js';
import { registerSessionEventHandlers, closeOrRemoveReplaced } from './session/sessionEventHandlers.js';
import type { SessionEventContext } from './session/sessionEventHandlers.js';
import { setupWebSocketHandler } from './api/wsHandler.js';
import { wsVisible, wsTermSubs, wsSnapshotOptOut, wsFocus } from './api/wsClientState.js';
import { startTranscriptWatcher } from './session/transcriptWatcher.js';
import { wirePtyEvents } from './pty/ptyEvents.js';
import { readGridText } from './pty/screenGrid.js';
import { feedCompactDetector, clearCompactDetector } from './pty/compactDetect.js';
import { listAll as listShellHistoryLogs, sweep as sweepShellHistory, enforceTotalCap as enforceShellHistoryCap, startPeriodicSweep as startShellHistorySweep, deleteLog as deleteShellHistoryLog } from './pty/shellHistoryLog.js';
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

// Tracks PTY spawns waiting to link to their live Claude session.
// Owns: byPid (linked once watcher sees the PID), byResumeId (ConPTY fallback),
// cloneInfo (--fork-session metadata applied on link).
const linkageTracker = new PtyLinkageTracker();

// Stable overlordId ↔ pty-xxx mapping (replaces ptyToClaudeId / claudeToPtyId).
// ovrId is stable across /clear and compaction; PTY id can change on restart.
const ovrToPty = new Map<string, string>(); // ovrId → pty-xxx
const ptyToOvr = new Map<string, string>(); // pty-xxx → ovrId

// Ring buffer for PTY output — replayed on new WS connections so the terminal isn't blank
const ptyOutputBuffer = new Map<string, Buffer[]>();
// Ring-buffer cap for per-session PTY output. Only consumed by `terminal:replay`,
// which BSU-slices for TUIs — 200 is plenty. 500 pushed multi-MB concat+base64
// per reconnect and dominated the event loop on long sessions.
const PTY_BUFFER_MAX_CHUNKS = 200;

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
    // Strip non-printable chars except newline/tab/CR. Preserve Unicode whitespace
    // (NBSP, thin space, etc.) as ASCII space — the Claude CLI status bar uses them
    // between words, and plain stripping destroys the "(shift+tab to cycle)" sentinel.
    .replace(/[^\x20-\x7e\n\t\r]/g, (ch) => /\s/.test(ch) ? ' ' : '');

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

// Flag to skip clear detection during startup (hydration + initial file scan)
let startupComplete = false;

// Map ptySessionId → clone name, applied after PTY is linked to a real Claude session
// Track pending clone info (name + original session) by ptySessionId.
// pendingCloneInfo (--fork-session metadata) now lives on linkageTracker.cloneInfo
// — see PtyLinkageTracker for the lifecycle methods.

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
  const migratedOvrId = stateManager.getSession(newId)?.overlordId ?? newId;
  broadcastRaw({ type: 'terminal:linked', ovrId: migratedOvrId, ptySessionId: `bridge-${newId}`, claudeSessionId: newId, replay: true });
  // Nudge the bridge so the fresh screen state flows into newId's buffer before xterm mounts
  setTimeout(() => void nudgeBridgePipe(newId), 300);
}

// Pending bridge connections for new sessions (marker → temp pipe name)
// When a new session appears with ___BRG:<marker> in its name, we link it to the bridge pipe.
const pendingBridgeByMarker = new Map<string, { pipeName: string; timestamp: number }>();
const PENDING_BRIDGE_MARKER_TTL_MS = 60_000;

/** Drop stale entries whose matching session never arrived (e.g. user closed terminal before spawn). */
function pruneStalePendingBridgeMarkers(): void {
  const cutoff = Date.now() - PENDING_BRIDGE_MARKER_TTL_MS;
  for (const [marker, entry] of pendingBridgeByMarker) {
    if (entry.timestamp < cutoff) pendingBridgeByMarker.delete(marker);
  }
}

// Helper: open a terminal window via overlord-bridge for reliable injection
function openTerminalWindow(cwd: string, command: string, title?: string, sessionId?: string, useBridge: boolean = true): Promise<void> {
  return openTerminalWindowImpl(
    { stateManager, bridgeManager, connectBridgePipe, pruneStalePendingBridgeMarkers, pendingBridgeByMarker },
    cwd, command, title, sessionId, useBridge,
  );
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
      // Revive sessions hydrated as 'closed' from sessionStore on restart.
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

function connectBridgeOutputSocket(sessionId: string, pipeAddr: string, pipeName: string, consecutiveFailures = 0): void {
  // Track reconnect time so we can suppress stale "Compacting conversation" detection in
  // the SIGWINCH-triggered repaint dump — the terminal may include old compact text that
  // no longer corresponds to a fresh compact_boundary.
  let reconnectAt = 0;
  // Send "OUTPT\n" handshake so bridge adds this socket to the broadcast list
  const outputSocket = net.connect(pipeAddr, () => {
    outputSocket.write('OUTPT\n', () => {
      reconnectAt = Date.now();
      // Clear the compact detector so buffered text from a previous connect doesn't
      // combine with repaint bytes to form a false "Compacting conversation" match.
      clearCompactDetector(sessionId);
      // Clear stale buffer — the bridge auto-nudges (SIGWINCH) when OUTPT connects,
      // producing a fresh full-screen repaint that fills the buffer from scratch.
      ptyOutputBuffer.delete(sessionId);
      console.log(`[bridge] output socket connected for ${sessionId.slice(0, 8)}`);
      // Clear bridgeDead flag — pipe is alive again.
      stateManager.clearBridgeDead(sessionId);
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

    // Screen-clear checkpoint: discard replay history so the buffer begins at a
    // self-contained screen, instead of cursor-position-dependent incremental
    // chunks rendering on top of unrelated history in a fresh xterm.
    //
    // This used to key on `\x1b[?2026h` (BSU, the synchronized-output marker Ink
    // once sent before each repaint). The current Claude CLI emits no BSU at all,
    // so the checkpoint never fired. `\x1b[2J` is emitted and carries the same
    // meaning here. Bridge sessions still replay from this buffer (they are not
    // fed into the screen grid), so unlike the embedded PTY path this reset stays.
    const isScreenClear = data.includes(0x1b) && data.toString('binary').includes('\x1b[2J');
    if (isScreenClear) {
      buf = [];
      ptyOutputBuffer.set(eid, buf);
    }

    buf.push(data);
    if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);
    // Broadcast under ovrId so client XtermTerminal (keyed by ovrId) receives the output.
    const broadcastId = stateManager.getSession(eid)?.overlordId ?? eid;
    broadcastTerminalOutput(broadcastId, { type: 'terminal:output', sessionId: broadcastId, data: data.toString('base64') });

    // Detect "Compacting conversation" in bridge output — mirrors the PTY path so bridge
    // sessions also surface the compact state in the Conversation tab before the
    // compact_boundary event lands in the transcript.
    // Suppress during the first 5s after reconnect: the SIGWINCH repaint may include stale
    // "Compacting conversation" text from the scrollback that no new compact_boundary will clear.
    const sinceConnectMs = reconnectAt > 0 ? Date.now() - reconnectAt : Infinity;
    if (sinceConnectMs > 5000) {
      feedCompactDetector(eid, data.toString('utf8'), (line) => {
        stateManager.addPtyCompact(broadcastId, line);
      });
    }

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
      const { sentinelFound, mode } = detectModeFromText(tail);
      if (sentinelFound) {
        const resolvedMode = mode ?? 'default';
        const prevMode = bridgePermMode.get(eid);
        bridgePermMode.set(eid, resolvedMode);
        // On transition, drop the rolling buffer so the next chunk starts clean —
        // prevents stale earlier status-bar text from winning over the new one.
        if (prevMode !== undefined && prevMode !== resolvedMode) {
          bridgePermText.delete(eid);
        }
        // Only reset to 'default' when session is at the interactive prompt (waiting).
        // During thinking/working, the full TUI may not be rendering the status bar.
        if (resolvedMode !== 'default' || stateManager.getSession(eid)?.state === 'waiting') {
          stateManager.setPermissionMode(eid, resolvedMode);
        }
      }

      // Detect active state so snapshot overrides stale 'waiting' while the transcript
      // hasn't yet received the first update from the new turn.
      // Uses a persistent flag (setBridgeActive) rather than a TTL so extended thinking
      // (which may produce sparse output) doesn't flicker back to 'waiting'.
      // Two active signals:
      //   1. Status bar "esc to interrupt" — normal working/tool-use
      //   2. Spinner pattern "· Word… (Ns" — extended thinking (no full repaint)
      // Cleared when status bar is present WITHOUT "esc to interrupt" (idle prompt).
      {
        const tail = (bridgePermText.get(eid) ?? '').slice(-2048);
        const tailLines = tail.split('\n');
        let activeSignal: boolean | null = null; // null = no signal yet
        for (let i = tailLines.length - 1; i >= 0; i--) {
          const line = tailLines[i];
          if (/\(shift\+tab to cycle\)/i.test(line)) {
            // Status bar: active iff "esc to interrupt" present
            activeSignal = /esc to interrupt/i.test(line);
            break;
          }
          // Spinner line: "· Crunching… (31s" or "* Drizzling… (47s · thinking with..."
          if (/[·*·]\s+\w+[.\u2026]+\s*\(\d/.test(line)) {
            activeSignal = true;
            break;
          }
        }
        if (activeSignal === true) stateManager.setBridgeActive(eid, true);
        else if (activeSignal === false) stateManager.setBridgeActive(eid, false);
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
    clearCompactDetector(currentId);
    if (!stateManager.isBridge(currentId)) return; // session gone, stop retrying
    if (outputConnectFailed) {
      const nextFailures = consecutiveFailures + 1;
      // Give up after 20 consecutive failures (~60s) — bridge is permanently dead
      if (nextFailures >= 20) {
        console.log(`[bridge] output pipe dead for ${sessionId.slice(0, 8)}, giving up after ${nextFailures} failures`);
        stateManager.setBridgeDead(currentId);
        return;
      }
      console.log(`[bridge] output pipe dead for ${sessionId.slice(0, 8)}, will retry... (${nextFailures}/20)`);
      setTimeout(() => connectBridgeOutputSocket(sessionId, pipeAddr, pipeName, nextFailures), 3000);
    } else {
      // Clean disconnect — reconnect quickly, reset failure counter.
      console.log(`[bridge] output pipe disconnected for ${sessionId.slice(0, 8)}, will reconnect...`);
      setTimeout(() => connectBridgeOutputSocket(sessionId, pipeAddr, pipeName, 0), 2000);
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
  // Heal: surface bridge sessions whose bridgePipeName was never persisted.
  // For legacy sessions opened via terminal:open-bridged (pipe = `overlord-{sid}`)
  // OR sessions created before setBridgePipe persisted, derive the pipe name
  // from the sessionId or the running bridge process command line.
  for (const session of stateManager.getAllSessions()) {
    if (session.sessionType !== 'bridge' || session.bridgePipeName) continue;
    if (registry[session.sessionId]) continue;
    // Legacy default: `overlord-${sessionId}`. The bridge socket lives in os.tmpdir().
    const candidate = `overlord-${session.sessionId}`;
    const sockPath = join(os.tmpdir(), `${candidate}.sock`);
    if (fs.existsSync(sockPath)) {
      console.log(`[bridge] healing missing bridgePipeName for ${session.sessionId.slice(0, 8)} → ${candidate}`);
      stateManager.setBridgePipe(session.sessionId, candidate);
      registry[session.sessionId] = candidate;
    }
  }
  const entries = Object.entries(registry);
  if (entries.length === 0) return;

  // Pre-seed linkedBridgeSessions with every known bridge so the first
  // post-boot `connected` event is treated as a reconnect (replay: true).
  // Without this, the initial terminal:linked omits replay → client treats
  // it as a fresh spawn → onSpawned fires → App.tsx auto-select effect
  // overwrites the selection the user had stored in the URL hash.
  for (const [sessionId] of entries) linkedBridgeSessions.add(sessionId);

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

// Broadcast snapshot to WS clients (wrapped with type field). Skips hidden
// tabs (wsVisible=false — they get a fresh snapshot on the visible flip) and
// opted-out clients (LogsPage). A snapshot is 300–600 KB re-sent at up to 5Hz;
// sending it to backgrounded tabs ratchets their renderer RSS by GBs/day.
// Returns the serialized byte count so the caller can log payload growth.
/** Last payload sent, per focus key — see the identical-payload skip below. */
const lastSnapshotPayloadByFocus = new Map<string, string>();
const NO_FOCUS = ' none';

/** Broadcast the snapshot, one serialization per DISTINCT focused session.
 *
 *  activityFeed is only sent for the session a client has open, so the payload
 *  is no longer identical for everyone. Grouping by focus keeps the stringify
 *  count at the number of distinct focused sessions — 1–2 in normal use, not one
 *  per client. `focusGroups` is logged so the day that assumption breaks (many
 *  tabs on many different sessions) is visible rather than silently slow. */
function broadcast(): number {
  const t0 = Date.now();
  const targets = new Map<string, WebSocket[]>();
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (wsVisible.get(client) === false || wsSnapshotOptOut.has(client)) continue;
    const key = wsFocus.get(client) ?? NO_FOCUS;
    const list = targets.get(key);
    if (list) list.push(client); else targets.set(key, [client]);
  }
  if (targets.size === 0) return 0;

  let bytes = 0;
  let stringifyMs = 0;
  for (const [key, clients] of targets) {
    const snap = stateManager.getSnapshot(key === NO_FOCUS ? undefined : key);
    const s0 = Date.now();
    const payload = JSON.stringify({ type: 'snapshot', ...snap });
    stringifyMs += Date.now() - s0;
    // Identical payload → these clients already have this exact state. onChange
    // fires on transcript touches that don't alter the snapshot at all, so this
    // skips a meaningful share of writes when the office is idle.
    if (payload === lastSnapshotPayloadByFocus.get(key)) continue;
    lastSnapshotPayloadByFocus.set(key, payload);
    for (const client of clients) client.send(payload);
    bytes += payload.length;
  }
  // Bound the map: focus keys churn as sessions are selected and closed.
  if (lastSnapshotPayloadByFocus.size > 32) {
    for (const key of lastSnapshotPayloadByFocus.keys()) {
      if (!targets.has(key)) lastSnapshotPayloadByFocus.delete(key);
    }
  }
  const totalMs = Date.now() - t0;
  if (totalMs > 100) console.log(`[perf] broadcast: focusGroups=${targets.size} stringify=${stringifyMs}ms total=${totalMs}ms bytes=${bytes}`);
  return bytes;
}

// Broadcast an arbitrary typed message to all connected WS clients
function broadcastRaw(msg: object): number {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
  return payload.length;
}

// Send a terminal:output-style message only to clients subscribed to this
// terminal (via terminal:replay / terminal:input / terminal:resize). Output
// for unwatched sessions is never pushed — ptyOutputBuffer replays it when a
// client mounts the terminal.
function broadcastTerminalOutput(termId: string, msg: object): number {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!wsTermSubs.get(client)?.has(termId)) continue;
    client.send(payload);
  }
  return payload.length;
}

// Wire up logger so it can broadcast log entries to all clients
initLogger((entry) => broadcastRaw({ type: 'log:entry', entry }));

// Hydrate in-memory mirrors from disk.
globalSettingsStore.load();
sessionStore.loadAll();
artifactStore.loadAll();

// Watch artifact files for external edits and rebroadcast as artifact:changed.
const artifactWatcher = new ArtifactWatcher(artifactStore, (event) => broadcastRaw(event));
artifactWatcher.start();

// Ensure skill-templates are linked into ~/.claude/skills/ so Claude Code sessions
// in any room can invoke them as slash commands. Uses absolute targets since the
// symlinks live outside the repo. No-op if already linked and pointing correctly.
// On Windows, directory symlinks require elevated privileges — falls back to
// junction points (no elevation needed) and logs a warning on any remaining failure.
(function linkSkillTemplates() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const templatesDir = join(repoRoot, 'skill-templates');
  const skillsDir = join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(templatesDir)) return;
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of fs.readdirSync(templatesDir)) {
    const absoluteTarget = join(templatesDir, name);
    const link = join(skillsDir, name);
    try {
      const existing = fs.lstatSync(link);
      if (existing.isSymbolicLink() && fs.readlinkSync(link) === absoluteTarget) continue;
      fs.unlinkSync(link);
    } catch { /* doesn't exist yet */ }
    try {
      // Use 'junction' on Windows for directories — no elevated privileges needed.
      const linkType = process.platform === 'win32' ? 'junction' : undefined;
      fs.symlinkSync(absoluteTarget, link, linkType);
      log('info', `[skills] linked ~/.claude/skills/${name} → ${absoluteTarget}`);
    } catch (err: any) {
      log('info', `[skills] could not link ~/.claude/skills/${name}: ${err.message} (skills in that directory will be unavailable)`);
    }
  }
})();

// Setup state manager
const stateManager = new StateManager(() => {
  // broadcast() builds the snapshot itself — it needs one per focused session,
  // not one shared object. Its own [perf] line covers the timing.
  broadcast();
});
// Inject ovrToPty-backed liveness probe so snapshots carry `ptyAlive` for embedded sessions.
stateManager.setHasLivePtyFn((ovrId) => {
  const ptyId = ovrToPty.get(ovrId);
  return !!(ptyId && ptyManager.has(ptyId));
});

const aiClassifier = new AiClassifier();
const intentSummarizer = new IntentSummarizer(stateManager);

// Rebroadcast snapshot (carries settings) + drain in-flight LLM queries
// when the kill switch flips on.
globalSettingsStore.onChange((next, prev) => {
  if (next.disableBackgroundLLM && !prev.disableBackgroundLLM) {
    killClaudeWorker();
  }
  const credsChanged =
    (next.jiraBaseUrl ?? '') !== (prev.jiraBaseUrl ?? '') ||
    (next.jiraEmail ?? '') !== (prev.jiraEmail ?? '') ||
    (next.jiraApiToken ?? '') !== (prev.jiraApiToken ?? '');
  if (credsChanged) clearJiraTitleCache();
  broadcast();
});

// Extract readable text from a raw terminal output buffer (last N chunks)
function bufferToText(chunks: Buffer[]): string | null {
  if (!chunks || chunks.length === 0) return null;
  return stripAnsi(Buffer.concat(chunks.slice(-50)).toString('utf8')).trim() || null;
}

// Screen text reader for permissionChecker — handles bridge, embedded PTY, and plain sessions.
// Prefers the headless VT grid (real rendered screen — handles \r / cursor repaints that
// in-place TUI menus like AskUserQuestion use); falls back to bufferToText if no grid yet.
async function getScreenText(sessionId: string, pid: number): Promise<string | null> {
  // Bridge sessions: grid/buffer keyed by sessionId (== ovrId for bridge).
  if (stateManager.isBridge(sessionId)) {
    return readGridText(sessionId) ?? bufferToText(ptyOutputBuffer.get(sessionId) ?? []);
  }
  // Embedded PTY sessions: resolve ovrId from session, then ptyId
  const session = stateManager.getSession(sessionId);
  const ovrId = session?.overlordId;
  const ptyId = ovrId ? ovrToPty.get(ovrId) : undefined;
  if (ptyId) {
    return (
      readGridText(ptyId) ??
      (ovrId ? readGridText(ovrId) : null) ??
      bufferToText(ptyOutputBuffer.get(ptyId) ?? (ovrId ? ptyOutputBuffer.get(ovrId) : undefined) ?? [])
    );
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
  ovrToPty,
  ptyToOvr,
  linkageTracker,
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

// Load closed sessions from transcripts on startup, then clean up stale ones
stateManager.loadClosedSessionsFromTranscripts()
  .then(() => stateManager.cleanupStaleTranscripts())
  .catch(err => {
    console.warn('[startup] failed to load/cleanup closed sessions:', err);
  });

// Revive raw-shell sessions from disk history logs (historyOnly). No PTYs spawned —
// user must click "Restart shell" in DetailPanel to resume live I/O.
try {
  const logs = listShellHistoryLogs();
  const isDeleted = (id: string) => stateManager.isDeleted(id);
  for (const { sessionId, meta, mtime } of logs) {
    if (isDeleted(sessionId)) {
      deleteShellHistoryLog(sessionId);
      continue;
    }
    if (stateManager.getSession(sessionId)) continue; // already in state
    if (!meta) continue; // orphan with no meta — sweep will clean it up
    stateManager.addHistoryOnlyRawSession(sessionId, meta.cwd, meta.name, mtime);
  }
  sweepShellHistory(id => !!stateManager.getSession(id));
  enforceShellHistoryCap();
  startShellHistorySweep(id => !!stateManager.getSession(id));
  console.log(`[startup] revived ${logs.length} shell-history session(s)`);
} catch (err) {
  console.warn('[startup] shell-history revival failed:', (err as Error).message);
}

// Consume the shutdown capture ONCE at boot, not when auto-resume runs: with
// the toggle off the file would otherwise survive across boots, and a later
// crash (which writes no capture) would resume a set from some much older
// shutdown. One capture ⇒ exactly one boot.
let liveAtShutdown = consumeLiveAtShutdown();
console.log(liveAtShutdown === null
  ? '[startup] no live-at-shutdown capture (crash or first run)'
  : `[startup] live-at-shutdown capture: ${liveAtShutdown.length} session(s)`);
if (liveAtShutdown === null) {
  // No clean capture ⇒ the server died without running shutdown(): a computer
  // restart (terminal teardown SIGHUPs/SIGKILLs us), a panic, or kill -9. Fall
  // back to the heartbeat mirror, which only reports a set it can prove is
  // safe to resume (see consumeLivePtyFallback's three guards).
  liveAtShutdown = consumeLivePtyFallback();
  if (liveAtShutdown) console.log(`[startup] recovered ${liveAtShutdown.length} session(s) from live-pty heartbeat (unclean shutdown)`);
} else {
  // The clean capture is authoritative; drop any heartbeat left behind.
  clearLivePtyHeartbeat();
}

function autoResumePtySessions(): Promise<void> {
  return autoResumePtySessionsImpl({ stateManager, ptyManager, ovrToPty, ptyToOvr, linkageTracker, liveAtShutdown });
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

/** Current live embedded-PTY set: what auto-resume would bring back if the
 *  server died right now. Shared by the heartbeat and by shutdown()'s capture. */
function buildLivePtyEntries(): LivePtyEntry[] {
  const live: LivePtyEntry[] = [];
  for (const [ovrId, ptyId] of ovrToPty) {
    const sid = sessionStore.getByOverlordId(ovrId)?.lineage.currentSessionId;
    if (sid) live.push({ ovrId, sessionId: sid, pid: ptyManager.getPid(ptyId) ?? 0 });
  }
  return live;
}

// Mirror the live PTY set to disk so an unclean death (computer restart, panic,
// kill -9) still has a record to auto-resume from — shutdown() only runs on
// SIGTERM/SIGINT/SIGHUP. Write-on-change only: an idle office writes nothing.
let lastHeartbeatKey = '';
setInterval(() => {
  try {
    const entries = buildLivePtyEntries();
    const key = entries.map(e => `${e.ovrId}:${e.sessionId}:${e.pid}`).sort().join('|');
    if (key === lastHeartbeatKey) return;
    lastHeartbeatKey = key;
    if (entries.length === 0) clearLivePtyHeartbeat();
    else writeLivePtyHeartbeat(entries);
  } catch (err) {
    console.warn('[live-pty] heartbeat tick failed:', (err as Error).message);
  }
}, 15_000).unref();

// Delete overlord-session files whose transcripts are missing or untouched
// for >2 days. Protected: every record hydrated into stateManager on boot
// (hydrateAllActiveSessions) is in liveOvrIds and is never touched, even when
// its state is "closed". Only truly orphaned records get dropped.
const purgeStaleFiles = () => {
  try {
    const n = stateManager.purgeStaleOverlordSessionFiles();
    if (n > 0) console.log(`[purge] removed ${n} overlord-session files (missing/old transcripts, not hydrated)`);
  } catch (err) {
    console.warn('[purge] failed:', (err as Error).message);
  }
};
setTimeout(purgeStaleFiles, 30_000).unref();
setInterval(purgeStaleFiles, 24 * 60 * 60 * 1000).unref();


// Transcript watcher + state refresh (moved to transcriptWatcher.ts)
startTranscriptWatcher({
  stateManager,
  ptyManager,
  aiClassifier,
  intentSummarizer,
  sessionCtx,
  broadcastRaw,
  linkageTracker,
});

// PTY event handlers (moved to ptyEvents.ts)
wirePtyEvents({
  ptyManager,
  stateManager,
  wsSessionMap,
  ovrToPty,
  ptyToOvr,
  linkageTracker,
  ptyOutputBuffer,
  PTY_BUFFER_MAX_CHUNKS,
  broadcastRaw,
  broadcastTerminalOutput,
  sendToClient,
});

// Bridge pipe events → broadcast to clients (same flow as PTY output)
bridgeManager.on('connected', (sessionId: string) => {
  const isReconnect = computeIsReconnect(linkedBridgeSessions, sessionId);
  const ovrId = stateManager.getSession(sessionId)?.overlordId ?? sessionId;
  console.log(`[bridge] connected event for ${sessionId.slice(0, 8)} ovrId=${ovrId}, broadcasting terminal:linked${isReconnect ? ' (reconnect/replay)' : ''}`);
  broadcastRaw({ type: 'terminal:linked', ovrId, ptySessionId: `bridge-${sessionId}`, claudeSessionId: sessionId, ...(isReconnect ? { replay: true } : {}) });
});

bridgeManager.on('output', (sessionId: string, data: Buffer) => {
  // Buffer for replay on reconnect (keyed by ovrId for consistency with embedded PTY)
  const ovrId = stateManager.getSession(sessionId)?.overlordId ?? sessionId;
  let buf = ptyOutputBuffer.get(ovrId);
  if (!buf) { buf = []; ptyOutputBuffer.set(ovrId, buf); }
  buf.push(data);
  if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);

  const encoded = data.toString('base64');
  broadcastTerminalOutput(ovrId, { type: 'terminal:output', sessionId: ovrId, data: encoded });
});

bridgeManager.on('disconnected', (sessionId: string) => {
  // Don't remove from bridgeSessions — the bridge terminal window is still alive,
  // the pipe will reconnect. Only remove when session is explicitly closed/deleted.
  console.log(`[bridge] disconnected from ${sessionId.slice(0, 8)}, will reconnect`);
});

// Shared helper: kill a Claude session by PID and remove its session file + state.
// Fast path (in-memory state + snapshot broadcast) runs synchronously; slow path
// (process kill + file I/O) is deferred via setImmediate so the UI updates first.
function deleteSession(sessionId: string, pid?: number, reason?: string): void {
  deleteSessionImpl(
    { stateManager, ptyManager, ovrToPty, ptyToOvr, bridgePermText, bridgePermMode, linkedBridgeSessions, bridgeIdOverrides },
    sessionId, pid, reason,
  );
}

// WebSocket handler (moved to wsHandler.ts)
setupWebSocketHandler(wss, {
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
  getLogBuffer: getBuffer,
});

// API routes (moved to apiRoutes.ts)
registerApiRoutes(
  app,
  stateManager,
  ptyManager,
  { ovrToPty, ptyToOvr, linkageTracker },
  deleteSession,
  ptyOutputBuffer,
  broadcastRaw,
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

async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, cleaning up...`);
  // 1. Notify clients so they can show a reconnecting state
  wss.clients.forEach(client => {
    try { client.send(JSON.stringify({ type: 'server:shutdown' })); } catch { /* ignore */ }
  });
  // 2. Record which sessions have a live PTY right now — after killAll the
  //    in-memory map is gone. Consumed once by auto-resume on next boot.
  //    FIRST, before any await: the OS grace period during a logout/restart can
  //    end mid-shutdown, and a lost capture means nothing auto-resumes.
  try {
    const live: LiveAtShutdownEntry[] = buildLivePtyEntries().map(({ ovrId, sessionId }) => ({ ovrId, sessionId }));
    writeLiveAtShutdown(live);
    console.log(`[shutdown] captured ${live.length} live PTY session(s) for auto-resume`);
    // The clean capture supersedes the heartbeat mirror.
    clearLivePtyHeartbeat();
  } catch { /* ignore */ }
  // 2b. Flush any pending SessionStore writes so durable state lands on disk
  try { await sessionStore.flushAll(); } catch { /* ignore */ }
  // 2c. Flush pending artifact writes and stop watcher
  try { await artifactStore.flushAll(); } catch { /* ignore */ }
  try { await artifactWatcher.stop(); } catch { /* ignore */ }
  // 3. Kill embedded PTY sessions gracefully (SIGTERM, not SIGKILL)
  //    so Claude CLI can clean up. Bridge sessions survive — they're external.
  ptyManager.killAll();
  // 4. Disconnect bridge sockets cleanly
  bridgeManager.disconnectAll();
  // 5. Close WS + HTTP
  wss.clients.forEach(client => client.terminate());
  wss.close();
  httpServer.close();
  console.log(`[shutdown] done, exiting`);
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
// A closing terminal (window closed, logout, computer restart) hangs up the
// controlling tty — node's default action for SIGHUP is to die instantly, which
// skipped the auto-resume capture entirely. Handle it like any other stop.
process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
