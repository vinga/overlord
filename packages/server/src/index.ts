import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { StateManager } from './session/stateManager.js';
import { SessionWatcher } from './session/sessionWatcher.js';
import { ProcessChecker } from './session/processChecker.js';
import { PtyManager } from './pty/ptyManager.js';
import { getBridgePath, getPipeName } from './pty/pipeInjector.js';
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

// Helper: open a terminal window via overlord-bridge for reliable injection
async function openTerminalWindow(cwd: string, command: string, title?: string, sessionId?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const windowTitle = (title ?? 'Claude').replace(/"/g, '');
    const bridgePath = getBridgePath();
    const bridgeExists = fs.existsSync(bridgePath);

    let fullCmd: string;
    if (bridgeExists && sessionId) {
      // Use bridge for reliable named-pipe injection
      const pipeName = getPipeName(sessionId);
      const safeBridge = bridgePath.replace(/\//g, '\\');
      fullCmd = `start "${windowTitle}" /D "${cwd}" cmd.exe /K "${safeBridge}" --pipe ${pipeName} -- ${command}`;
      bridgeSessions.add(sessionId);
      console.log(`[open-terminal] using bridge, pipe=${pipeName}`);
    } else {
      // Fallback: direct spawn (no bridge binary available)
      fullCmd = `start "${windowTitle}" /D "${cwd}" cmd.exe /K ${command}`;
      console.log('[open-terminal] no bridge, direct spawn');
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
};

// Setup session watcher
const sessionWatcher = new SessionWatcher();
registerSessionEventHandlers(sessionWatcher, sessionCtx);
sessionWatcher.start();
startupComplete = true;

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

