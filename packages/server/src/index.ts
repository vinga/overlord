import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec, execSync, spawn } from 'child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import { StateManager } from './stateManager.js';
import { SessionWatcher } from './sessionWatcher.js';
import { ProcessChecker } from './processChecker.js';
import { PtyManager } from './ptyManager.js';
import { injectText, approvePermission } from './consoleInjector.js';
import { startPermissionChecker } from './permissionChecker.js';
import { findTranscriptPathAnywhere, markTranscriptDirty } from './transcriptReader.js';
import { appendTaskSummary } from './taskStorage.js';
import { runClaudeQuery } from './claudeQuery.js';
import { initLogger, log, getBuffer } from './logger.js';
import type { OfficeSnapshot } from './types.js';

// Per-session debounce timers for active task label generation
const activeTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Per-session debounce timers for chokidar transcript events
const transcriptDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeLabelGenerations = new Set<string>();

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

function applyPendingCloneInfo(ptySessionId: string, claudeSessionId: string): void {
  const info = pendingCloneInfo.get(ptySessionId);
  if (info) {
    pendingCloneInfo.delete(ptySessionId);
    const session = stateManager.getSession(claudeSessionId);
    if (session) {
      session.proposedName = info.name;
      session.resumedFrom = info.originalSessionId;
      // Trigger transcript refresh so the resumedFrom fallback populates the activity feed
      stateManager.refreshTranscript(claudeSessionId);
    }
    log('info', `Applied clone info: name="${info.name}", resumedFrom=${info.originalSessionId.slice(0, 8)} → ${claudeSessionId.slice(0, 8)}`);
  }
}

// Helper: check if any PTY resume is currently in progress (pendingPtyByResumeId not yet consumed)
function hasActiveResumeInProgress(): boolean {
  return pendingPtyByResumeId.size > 0;
}

// Helper: close or remove a replaced session during /clear detection.
// If the old session has no own transcript, it's an empty shell — remove entirely.
// If it has a transcript, keep it as closed (it has conversation history worth preserving).
function closeOrRemoveReplaced(oldSessionId: string): void {
  const hasTranscript = !!findTranscriptPathAnywhere(oldSessionId);
  if (hasTranscript) {
    stateManager.markClosed(oldSessionId);
  } else {
    stateManager.remove(oldSessionId);
    log('session:removed', 'Removed empty replaced session', { sessionId: oldSessionId, sessionName: oldSessionId.slice(0, 8) });
  }
}

// Helper: open a terminal window (tries Windows Terminal, falls back to cmd.exe)
async function openTerminalWindow(cwd: string, command: string, title?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // "start" is a cmd.exe built-in — must run via shell:true
    // /D sets working directory; first quoted arg is the window title
    const windowTitle = (title ?? 'Claude').replace(/"/g, '');
    const fullCmd = `start "${windowTitle}" /D "${cwd}" cmd.exe /K ${command}`;
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

// Migrate PTY routing maps when a session UUID changes (e.g. /clear)
// Tries by session ID first, then falls back to finding any PTY entry sharing the same PID.
function migratePtyMaps(oldSessionId: string, newSessionId: string, pid?: number): void {
  let oldPtyId = claudeToPtyId.get(oldSessionId);
  // Fallback: if oldSessionId isn't in the map, find any entry whose PTY has the same PID.
  // This handles /clear after resume — the PTY is linked to the resume's UUID, not the original.
  if (!oldPtyId && pid && pid > 0) {
    for (const [claudeId, ptyId] of claudeToPtyId) {
      if (ptyManager.getPid(ptyId) === pid || stateManager.getSession(claudeId)?.pid === pid) {
        oldPtyId = ptyId;
        claudeToPtyId.delete(claudeId);
        break;
      }
    }
  }
  if (oldPtyId) {
    claudeToPtyId.set(newSessionId, oldPtyId);
    ptyToClaudeId.set(oldPtyId, newSessionId);
    stateManager.setLaunchMethod(newSessionId, 'overlord-pty');
    // Notify clients to migrate their PTY output handlers
    broadcastRaw({ type: 'terminal:session-replaced', oldSessionId, newSessionId });
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

let autoResumeTriggered = false;

// Start permission checker (Windows-only; no-op on other platforms)
startPermissionChecker(stateManager);

// Setup session watcher
const sessionWatcher = new SessionWatcher();
sessionWatcher.on('added', (raw) => {
  // Skip interim session: claude --resume creates a temp UUID first, then settles to target ID.
  // If there's a pending PTY resume for this CWD and this is NOT the target ID, skip it —
  // but only if the interim has no transcript (safety: don't discard sessions with real data).
  const pendingResumeTarget = stateManager.getPendingResumeTarget(raw.cwd);
  if (pendingResumeTarget && raw.sessionId !== pendingResumeTarget && pendingPtyByResumeId.has(pendingResumeTarget)) {
    const interimTranscript = findTranscriptPathAnywhere(raw.sessionId);
    if (!interimTranscript) {
      console.log(`[session:skip-interim] ${raw.sessionId.slice(0, 8)} is interim for resume target ${pendingResumeTarget.slice(0, 8)}, skipping (no transcript)`);
      return;
    }
  }
  const { isNewWaiting, lastMessage } = stateManager.addOrUpdate(raw);
  if (isNewWaiting && lastMessage && raw.kind !== 'haiku-worker') void classifyCompletion(raw.sessionId, lastMessage);
  // Log session creation
  const createdName = raw.proposedName ?? raw.sessionId.slice(0, 8);
  log('session:created', 'Session created', { sessionId: raw.sessionId, sessionName: createdName, extra: `PID ${raw.pid} name=${raw.name ?? 'NONE'}` });
  // Link PTY by embedded marker in session name (works for spawn, resume, and clone)
  let linkedToPty = false;
  if (raw.name && raw.name.includes('___OVR:')) {
    const marker = raw.name.split('___OVR:')[1];
    const ptyAlive = ptyManager.has(marker);
    console.log(`[marker-check] added: marker=${marker} ptyAlive=${ptyAlive}`);
    if (marker && ptyAlive) {
      linkedToPty = true;
      ptyToClaudeId.set(marker, raw.sessionId);
      claudeToPtyId.set(raw.sessionId, marker);
      // Find the WS that owns this PTY
      let ownerWs: WebSocket | null = null;
      for (const [ws, sessions] of wsSessionMap) {
        if (sessions.has(marker)) {
          ownerWs = ws;
          break;
        }
      }
      if (ownerWs) {
        const wsSessions = wsSessionMap.get(ownerWs);
        if (wsSessions) wsSessions.add(raw.sessionId);
        sendToClient(ownerWs, { type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
      } else {
        for (const sessions of wsSessionMap.values()) {
          sessions.add(raw.sessionId);
        }
        broadcastRaw({ type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
      }
      stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
      const ptyPid = ptyManager.getPid(marker);
      if (ptyPid) stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(marker, raw.sessionId);
      log('pty:started', 'PTY clone linked via name marker', { sessionId: raw.sessionId });
    }
  }
  // Link PTY session to real Claude session by PID
  if (!linkedToPty && raw.pid && pendingPtyByPid.has(raw.pid)) {
    const entry = pendingPtyByPid.get(raw.pid)!;
    pendingPtyByPid.delete(raw.pid);
    linkedToPty = true;
    // Set up ID mapping so output is rerouted from pty-xxx to real claudeSessionId
    ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
    claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
    stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
    if (entry.ws) {
      // Normal spawn: link to the owning WS client
      const wsSessions = wsSessionMap.get(entry.ws);
      if (wsSessions) wsSessions.add(raw.sessionId);
      sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    } else {
      // Auto-resume: broadcast linked event to all clients, migrate all wsSessionMap entries
      for (const sessions of wsSessionMap.values()) {
        sessions.add(raw.sessionId);
      }
      broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    }
    stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
    // Update the session's PID to the PTY process PID so ProcessChecker doesn't mark it closed
    const ptyPid = ptyManager.getPid(entry.ptySessionId);
    if (ptyPid) stateManager.setPid(raw.sessionId, ptyPid);
    applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
    const ptySessionName = stateManager.getSession(raw.sessionId)?.proposedName ?? raw.proposedName ?? raw.sessionId.slice(0, 8);
    log('pty:started', 'PTY session started', { sessionId: raw.sessionId, sessionName: ptySessionName });
  } else if (raw.pid && !pendingPtyByPid.has(raw.pid) && stateManager.hasPendingResume(raw.cwd)) {
    // PID not in pendingPtyByPid yet — PTY may not have emitted pid-ready; retry after 500ms
    const retryPid = raw.pid;
    const retrySessionId = raw.sessionId;
    const retryCwd = raw.cwd;
    setTimeout(() => {
      if (pendingPtyByPid.has(retryPid)) {
        const entry = pendingPtyByPid.get(retryPid)!;
        pendingPtyByPid.delete(retryPid);
        ptyToClaudeId.set(entry.ptySessionId, retrySessionId);
        claudeToPtyId.set(retrySessionId, entry.ptySessionId);
        if (entry.ws) {
          const wsSessions = wsSessionMap.get(entry.ws);
          if (wsSessions) wsSessions.add(retrySessionId);
          sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: retrySessionId });
        } else {
          for (const sessions of wsSessionMap.values()) {
            sessions.add(retrySessionId);
          }
          broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: retrySessionId });
        }
        stateManager.setLaunchMethod(retrySessionId, 'overlord-pty');
        const retryPtyPid = ptyManager.getPid(entry.ptySessionId);
        if (retryPtyPid) stateManager.setPid(retrySessionId, retryPtyPid);
        applyPendingCloneInfo(entry.ptySessionId, retrySessionId);
        log('pty:started', 'PTY linked after retry', { sessionId: retrySessionId, sessionName: retrySessionId.slice(0, 8) });
      }
    }, 500);
  }
  // Fallback linking: match by sessionId directly in pendingPtyByResumeId (ConPTY resume flow)
  if (!linkedToPty && pendingPtyByResumeId.has(raw.sessionId)) {
    const entry = pendingPtyByResumeId.get(raw.sessionId)!;
    pendingPtyByResumeId.delete(raw.sessionId);
    linkedToPty = true;
    ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
    claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
    // Clear startup noise from the PTY buffer before linking
    ptyOutputBuffer.delete(entry.ptySessionId);
    if (entry.ws) {
      const wsSessions = wsSessionMap.get(entry.ws);
      if (wsSessions) wsSessions.add(raw.sessionId);
      sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    } else {
      for (const sessions of wsSessionMap.values()) {
        sessions.add(raw.sessionId);
      }
      broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    }
    stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
    const ptyPid = ptyManager.getPid(entry.ptySessionId);
    if (ptyPid) stateManager.setPid(raw.sessionId, ptyPid);
    applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
    log('pty:started', 'PTY linked via resumeId', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8) });
  }
  // Detect session replacement: same PID, different UUID (e.g. Claude Code's /clear)
  // Skip if this session was just linked to a PTY — it's a resume, not a /clear.
  // Skip during startup — known sessions from the initial scan are not /clear replacements.
  let replacedByPid = false;
  if (startupComplete && !linkedToPty && raw.pid && raw.pid > 0 && !pendingPtyByPid.has(raw.pid) && !hasActiveResumeInProgress()) {
    const oldSession = stateManager.findSessionByPid(raw.pid, raw.sessionId);
    if (oldSession) {
      closeOrRemoveReplaced(oldSession.sessionId);
      stateManager.transferName(oldSession.sessionId, raw.sessionId);
      migratePtyMaps(oldSession.sessionId, raw.sessionId, raw.pid);
      broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId });
      const clearName1 = raw.proposedName ?? raw.sessionId.slice(0, 8);
      log('clear:detected', 'Clear detected', { sessionId: raw.sessionId, sessionName: clearName1, extra: oldSession.sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
      replacedByPid = true;
    }
  }
  // Fallback: CWD-based replacement detection for /clear (creates new PID)
  if (startupComplete && !linkedToPty && !replacedByPid && !pendingPtyByPid.has(raw.pid) && !stateManager.hasPendingResume(raw.cwd) && !hasActiveResumeInProgress()) {
    const recent = recentlyRemovedByCwd.get(raw.cwd);
    const isCaveatSession = lastMessage?.startsWith('<local-command-caveat') ?? false;
    if (recent && recent.sessionId !== raw.sessionId && (Date.now() - recent.removedAt < 30000 || isCaveatSession)) {
      recentlyRemovedByCwd.delete(raw.cwd);
      closeOrRemoveReplaced(recent.sessionId);
      stateManager.transferName(recent.sessionId, raw.sessionId);
      migratePtyMaps(recent.sessionId, raw.sessionId, raw.pid);
      broadcastRaw({ type: 'session:replaced', oldSessionId: recent.sessionId, newSessionId: raw.sessionId });
      const clearName2 = raw.proposedName ?? raw.sessionId.slice(0, 8);
      log('clear:detected', 'Clear detected', { sessionId: raw.sessionId, sessionName: clearName2, extra: recent.sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
    }
  }
});
sessionWatcher.on('changed', (raw) => {
  // Detect in-place session replacement (e.g. Claude Code's /clear for non-PTY sessions)
  // The session file updates in-place with a new sessionId — same PID, different UUID
  if (raw.pid && raw.pid > 0) {
    const oldSession = stateManager.findSessionByPid(raw.pid, raw.sessionId);
    if (oldSession && oldSession.sessionId !== raw.sessionId) {
      // If the old session was an interim resume phantom (resumedFrom === new sessionId), remove entirely
      if (oldSession.resumedFrom === raw.sessionId) {
        stateManager.remove(oldSession.sessionId);
      } else {
        closeOrRemoveReplaced(oldSession.sessionId);
      }
      stateManager.addOrUpdate(raw);
      stateManager.transferName(oldSession.sessionId, raw.sessionId);
      migratePtyMaps(oldSession.sessionId, raw.sessionId);
      broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId });
      return; // already called addOrUpdate above
    }
  }
  stateManager.addOrUpdate(raw);
  // Link PTY by embedded marker in session name (changed handler)
  if (raw.name && raw.name.includes('___OVR:') && !claudeToPtyId.has(raw.sessionId)) {
    const marker = raw.name.split('___OVR:')[1];
    const ptyAlive = ptyManager.has(marker);
    console.log(`[marker-check] changed: sid=${raw.sessionId.slice(0,8)} marker=${marker} ptyAlive=${ptyAlive} alreadyLinked=${claudeToPtyId.has(raw.sessionId)}`);
    if (marker && ptyAlive) {
      ptyToClaudeId.set(marker, raw.sessionId);
      claudeToPtyId.set(raw.sessionId, marker);
      let ownerWs: WebSocket | null = null;
      for (const [ws, sessions] of wsSessionMap) {
        if (sessions.has(marker)) {
          ownerWs = ws;
          break;
        }
      }
      if (ownerWs) {
        const wsSessions = wsSessionMap.get(ownerWs);
        if (wsSessions) wsSessions.add(raw.sessionId);
        sendToClient(ownerWs, { type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
      } else {
        for (const sessions of wsSessionMap.values()) {
          sessions.add(raw.sessionId);
        }
        broadcastRaw({ type: 'terminal:linked', ptySessionId: marker, claudeSessionId: raw.sessionId });
      }
      stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
      const ptyPid = ptyManager.getPid(marker);
      if (ptyPid) stateManager.setPid(raw.sessionId, ptyPid);
      applyPendingCloneInfo(marker, raw.sessionId);
      log('pty:started', 'PTY clone linked via name marker (changed)', { sessionId: raw.sessionId });
    }
  }
  // Check for pending PTY resume link (ConPTY: session file settles to target ID)
  if (pendingPtyByResumeId.has(raw.sessionId)) {
    const entry = pendingPtyByResumeId.get(raw.sessionId)!;
    pendingPtyByResumeId.delete(raw.sessionId);
    ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
    claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
    // Clear startup noise from the PTY buffer before linking
    ptyOutputBuffer.delete(entry.ptySessionId);
    if (entry.ws) {
      const wsSessions = wsSessionMap.get(entry.ws);
      if (wsSessions) wsSessions.add(raw.sessionId);
      sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    } else {
      for (const sessions of wsSessionMap.values()) {
        sessions.add(raw.sessionId);
      }
      broadcastRaw({ type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    }
    stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
    const ptyPid = ptyManager.getPid(entry.ptySessionId);
    if (ptyPid) stateManager.setPid(raw.sessionId, ptyPid);
    applyPendingCloneInfo(entry.ptySessionId, raw.sessionId);
    log('pty:started', 'PTY linked via resumeId (changed)', { sessionId: raw.sessionId, sessionName: raw.sessionId.slice(0, 8) });
  }
});
sessionWatcher.on('removed', (sessionId: string) => {
  const session = stateManager.getSession(sessionId);
  const removedName = stateManager.getSession(sessionId)?.proposedName ?? sessionId.slice(0, 8);
  log('session:removed', 'Session removed', { sessionId, sessionName: removedName, extra: 'PID ' + (session?.pid ?? '?') });
  // Clean up PTY maps for removed sessions
  const ptyId = claudeToPtyId.get(sessionId);
  if (ptyId) {
    claudeToPtyId.delete(sessionId);
    ptyToClaudeId.delete(ptyId);
    console.log(`[removed] cleaned up PTY maps for ${sessionId} → pty=${ptyId}`);
  }
  if (session?.isWorker) {
    stateManager.remove(sessionId);
  } else {
    stateManager.markClosed(sessionId);
    // Track for CWD-based replacement detection (/clear creates new PID)
    if (session) {
      const now = Date.now();
      // Prune stale entries (older than 30s) to keep the map bounded
      for (const [cwd, entry] of recentlyRemovedByCwd) {
        if (now - entry.removedAt > 30000) recentlyRemovedByCwd.delete(cwd);
      }
      recentlyRemovedByCwd.set(session.cwd, { sessionId, removedAt: now });
    }
  }
});
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

// Watch project transcripts for real-time updates
const projectsDir = join(os.homedir(), '.claude', 'projects');

function parseTranscriptPath(filePath: string): { sessionId: string; isSubagent: boolean } | null {
  if (!filePath.endsWith('.jsonl')) return null;
  const parts = filePath.replace(/\\/g, '/').split('/');
  const subagentsIdx = parts.indexOf('subagents');
  const isSubagent = subagentsIdx !== -1;
  // For subagents, sessionId is the parent session (one level above 'subagents')
  // For main files, sessionId is derived from the basename
  const sessionId = isSubagent
    ? (parts[subagentsIdx - 1] ?? '')
    : (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '');
  if (!sessionId) return null;
  return { sessionId, isSubagent };
}

function handleTranscriptFile(filePath: string): void {
  const parsed = parseTranscriptPath(filePath);
  if (!parsed) return;
  // Mark dirty immediately so the next poll knows to re-read the file
  markTranscriptDirty(filePath);
  const { sessionId } = parsed;
  const existing = transcriptDebounceTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  transcriptDebounceTimers.set(sessionId, setTimeout(() => {
    transcriptDebounceTimers.delete(sessionId);
    stateManager.refreshTranscript(sessionId);
  }, 150));
}
// Handle new .jsonl files appearing — detect /clear session replacement
function handleTranscriptAdded(filePath: string): void {
  const parsed = parseTranscriptPath(filePath);
  if (!parsed) return;

  if (parsed.isSubagent) {
    handleTranscriptFile(filePath);
    return;
  }

  const newSessionId = parsed.sessionId;
  if (!newSessionId) return;

  // If already known, nothing to do — normal refresh will handle it
  if (stateManager.getSession(newSessionId)) {
    handleTranscriptFile(filePath);
    return;
  }

  // Unknown session: read cwd from the transcript to detect /clear replacement
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let cwd: string | undefined;
    for (const line of lines.slice(0, 15)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.cwd && typeof entry.cwd === 'string') { cwd = entry.cwd; break; }
      } catch { /* skip malformed */ }
    }

    if (!cwd) {
      // No cwd found yet — let normal flow handle it
      handleTranscriptFile(filePath);
      return;
    }

    // Find the most recently active non-closed session in the same CWD — that's the cleared one.
    const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();
    let bestSession: { sessionId: string; pid: number; isWorker?: boolean } | null = null;
    let bestActivity = -Infinity;

    for (const sid of stateManager.getAllSessionIds()) {
      if (sid === newSessionId) continue;
      const s = stateManager.getSession(sid);
      if (!s || s.state === 'closed') continue;
      if (s.cwd.replace(/\\/g, '/').toLowerCase() !== normalizedCwd) continue;
      const t = new Date(s.lastActivity).getTime();
      if (t > bestActivity) {
        bestActivity = t;
        bestSession = { sessionId: sid, pid: s.pid, isWorker: s.isWorker };
      }
    }

    // Skip /clear detection if a PTY resume is in progress — interim sessions are not /clear replacements
    if (hasActiveResumeInProgress()) {
      console.log(`[transcript:add] skipping /clear detection for ${newSessionId.slice(0, 8)} — PTY resume in progress`);
      handleTranscriptFile(filePath);
      return;
    }

    if (bestSession !== null) {
      closeOrRemoveReplaced(bestSession.sessionId);
      stateManager.addOrUpdate({
        sessionId: newSessionId,
        pid: bestSession.pid,
        cwd,
        startedAt: Date.now(),
        kind: bestSession.isWorker ? 'haiku-worker' : undefined,
      });
      stateManager.transferName(bestSession.sessionId, newSessionId);
      migratePtyMaps(bestSession.sessionId, newSessionId);
      broadcastRaw({ type: 'session:replaced', oldSessionId: bestSession.sessionId, newSessionId });
      const clearName3 = stateManager.getSession(newSessionId)?.proposedName ?? newSessionId.slice(0, 8);
      log('clear:detected', 'Clear detected', { sessionId: newSessionId, sessionName: clearName3, extra: bestSession.sessionId.slice(0, 8) + ' → ' + newSessionId.slice(0, 8) });
      console.log(`[transcript:add] /clear detected: ${bestSession.sessionId} → ${newSessionId} (cwd: ${cwd})`);
    } else {
      // No matching session found — register as new standalone session
      stateManager.addOrUpdate({
        sessionId: newSessionId,
        pid: 0,
        cwd,
        startedAt: Date.now(),
      });
      console.log(`[transcript:add] new standalone session: ${newSessionId} (cwd: ${cwd})`);
    }
  } catch {
    // If we can't read the file yet, fall through to the normal handler
  }

  // Always let the normal refresh flow run so the new session gets registered
  handleTranscriptFile(filePath);
}

chokidar
  .watch(projectsDir, {
    depth: 4,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  })
  .on('add', handleTranscriptAdded)
  .on('change', handleTranscriptFile);

// Scan for orphaned .jsonl transcript files that existed before the watcher started
// (e.g. created by /clear while the server was down, or missed due to ignoreInitial: true).
//
// Periodic state refresh — re-evaluate all session states every 3s
// (smallest state threshold is 3s, so polling must be at least that frequent)
setInterval(() => {
  for (const sessionId of stateManager.getAllSessionIds()) {
    const session = stateManager.getSession(sessionId);
    if (session?.state === 'closed') continue;
    const { becameWaiting, lastMessage, becameWorking, leftWorking, transcriptStale } = stateManager.refreshTranscript(sessionId);
    // Stale transcript detection: re-read session file to check for /clear
    if (transcriptStale) {
      const sess2 = stateManager.getSession(sessionId);
      if (sess2 && sess2.pid > 0) {
        const sessionFilePath = join(os.homedir(), '.claude', 'sessions', `${sess2.pid}.json`);
        try {
          if (fs.existsSync(sessionFilePath)) {
            const raw = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8')) as { pid: number; sessionId: string; cwd: string; startedAt: number };
            if (raw.sessionId !== sessionId) {
              const clearName = sess2.proposedName ?? sessionId.slice(0, 8);
              closeOrRemoveReplaced(sessionId);
              stateManager.addOrUpdate(raw);
              stateManager.transferName(sessionId, raw.sessionId);
              migratePtyMaps(sessionId, raw.sessionId, sess2.pid);
              broadcastRaw({ type: 'session:replaced', oldSessionId: sessionId, newSessionId: raw.sessionId });
              log('clear:detected', 'Stale transcript clear detected', { sessionId: raw.sessionId, sessionName: clearName, extra: sessionId.slice(0, 8) + ' → ' + raw.sessionId.slice(0, 8) });
            }
          }
        } catch {
          // ignore read errors
        }
      }
    }
    const sess = stateManager.getSession(sessionId);
    if (becameWaiting && lastMessage && !sess?.isWorker) {
      void classifyCompletion(sessionId, lastMessage);
    }
    if (becameWorking && !sess?.isWorker) {
      const prev = activeTaskTimers.get(sessionId);
      if (prev) clearTimeout(prev);
      activeTaskTimers.set(sessionId, setTimeout(() => { void generateActiveLabel(sessionId); }, 3_000));
    }
    if (leftWorking && !sess?.isWorker) {
      const t = activeTaskTimers.get(sessionId);
      if (t) { clearTimeout(t); activeTaskTimers.delete(sessionId); }
    }
    // Fallback: sessions already working/thinking with no label and no pending timer
    const currentSession = stateManager.getSession(sessionId);
    if (currentSession && !currentSession.isWorker && (currentSession.state === 'working' || currentSession.state === 'thinking') && !currentSession.currentTaskLabel && !activeTaskTimers.has(sessionId) && !activeLabelGenerations.has(sessionId)) {
      activeTaskTimers.set(sessionId, setTimeout(() => { void generateActiveLabel(sessionId); }, 3_000));
    }
  }
}, 3_000);

// Periodic cleanup of leaked PTY entries (every 60s)
setInterval(() => {
  for (const [pid, entry] of pendingPtyByPid) {
    if (!ptyManager.has(entry.ptySessionId)) {
      pendingPtyByPid.delete(pid);
    }
  }
  // Clean up stale pendingPtyByResumeId entries (older than 60s or PTY no longer alive)
  const now = Date.now();
  for (const [resumeId, entry] of pendingPtyByResumeId) {
    if (now - entry.timestamp > 60_000 || !ptyManager.has(entry.ptySessionId)) {
      pendingPtyByResumeId.delete(resumeId);
    }
  }
}, 60_000);

async function generateActiveLabel(sessionId: string): Promise<void> {
  activeTaskTimers.delete(sessionId);
  if (activeLabelGenerations.has(sessionId)) return;
  activeLabelGenerations.add(sessionId);

  try {
    const session = stateManager.getSession(sessionId);
    if (!session || (session.state !== 'working' && session.state !== 'thinking')) return;

    // Build context from activity feed
    const feed = session.activityFeed ?? [];
    const reversed = [...feed].reverse();

    // Last actual user text (skip empty tool-result messages)
    const lastUserMsg = reversed.find(i => i.kind === 'message' && i.role === 'user' && i.content?.trim())?.content?.slice(0, 200) ?? '';
    // Last tool call name
    const lastTool = reversed.find(i => i.kind === 'tool');
    const toolContext = lastTool ? `${lastTool.toolName ?? 'tool'}` : '';
    // Last assistant text (from session.lastMessage as fallback)
    const lastAssistantMsg = session.lastMessage?.slice(0, 150) ?? reversed.find(i => i.kind === 'message' && i.role === 'assistant' && i.content?.trim())?.content?.slice(0, 150) ?? '';

    // Need at least some context
    const context = [lastUserMsg, toolContext, lastAssistantMsg].filter(Boolean).join(' | ');
    if (!context.trim()) {
      console.log(`[label] ${sessionId.slice(0, 8)} skipped — no context`);
      return;
    }

    const prompt = `A Claude Code AI agent is actively working. Describe what it is doing in 3-4 words. Be specific and action-oriented. No punctuation. No preamble.\n\nContext: "${context}"\n\n3-4 word label:`;

    try {
      console.log(`[label] ${sessionId.slice(0, 8)} generating...`);
      const raw = await runClaudeQuery(prompt, 45_000, () => {
        const s = stateManager.getSession(sessionId);
        return s != null && (s.state === 'working' || s.state === 'thinking');
      });
      const label = raw.trim().replace(/^["']|["']$/g, '').slice(0, 40);
      // Only apply if still working/thinking
      const current = stateManager.getSession(sessionId);
      if (current && (current.state === 'working' || current.state === 'thinking')) {
        console.log(`[label] ${sessionId.slice(0, 8)} → "${label}"`);
        stateManager.setCurrentTaskLabel(sessionId, label);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'invalidated') console.warn(`[label] ${sessionId.slice(0, 8)} failed:`, msg);
    }
  } finally {
    activeLabelGenerations.delete(sessionId);
  }
}

function classifyByHeuristic(message: string): 'done' | 'awaiting' | null {
  const text = message.trim();
  const lower = text.toLowerCase();

  // Early check: bare "done" variants (e.g. "Done", "Done.", "Done!", "done.")
  if (/^done[.!\s]*$/i.test(text)) return 'done';

  // Very short messages are conversational, not task completions
  if (text.length < 40) return 'awaiting';

  // Ends with a question mark
  if (text.endsWith('?')) return 'awaiting';

  // Common question/clarification starters
  const awaitingPhrases = [
    'would you like', 'should i ', 'shall i ', 'do you want',
    'what would you', 'let me know if', 'is there anything',
    'do you have any', 'are you sure', 'can i help',
    'which ', 'how would you',
  ];
  if (awaitingPhrases.some(p => lower.includes(p))) return 'awaiting';

  // Obvious completion signals
  const donePhrases = [
    "i've completed", "i've finished", "i have completed", "i have finished",
    'has been completed', 'has been created', 'has been updated', 'has been fixed',
    'successfully ', 'all done', 'task complete', 'done!', 'done.', 'fixed.', 'completed.',
  ];
  if (donePhrases.some(p => lower.includes(p))) return 'done';

  return null; // inconclusive — call Haiku
}

async function classifyCompletion(sessionId: string, lastMessage: string): Promise<void> {
  const heuristic = classifyByHeuristic(lastMessage);
  if (heuristic !== null) {
    console.log(`[classify] ${sessionId.slice(0, 8)} → ${heuristic} (heuristic)`);
    stateManager.setCompletionHint(sessionId, heuristic, lastMessage);
    if (heuristic === 'done') {
      setTimeout(() => { void generateCompletionSummary(sessionId, lastMessage); }, 2_000);
    }
    return;
  }
  try {
    const prompt = `A Claude Code AI agent sent this message to a user. Did it complete a task/request (and is done), or is it asking a question / waiting for more user instructions?\n\nMessage: "${lastMessage.slice(0, 300)}"\n\nReply with exactly one word: done OR awaiting`;
    console.log(`[classify] ${sessionId.slice(0, 8)} querying haiku...`);
    const result = await runClaudeQuery(prompt, 45_000, () => {
      const s = stateManager.getSession(sessionId);
      return s?.state === 'waiting' && s?.lastMessage === lastMessage.slice(0, 300);
    });
    const hint = result.toLowerCase().includes('done') ? 'done' : 'awaiting';
    console.log(`[classify] ${sessionId.slice(0, 8)} → ${hint} (raw: "${result.trim()}")`);
    stateManager.setCompletionHint(sessionId, hint, lastMessage.slice(0, 300));
    if (hint === 'done') {
      // Wait 2s to confirm state is stable, then generate a one-line summary
      setTimeout(() => { void generateCompletionSummary(sessionId, lastMessage); }, 2_000);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== 'invalidated') console.warn(`[classify] ${sessionId.slice(0, 8)} failed:`, msg);
  }
}

async function generateCompletionSummary(sessionId: string, forMessage: string): Promise<void> {
  try {
    const transcriptPath = findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) return;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    // Collect last 10 assistant messages for context
    const msgs: string[] = [];
    for (let i = lines.length - 1; i >= 0 && msgs.length < 10; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { type?: string; message?: { content?: unknown } };
        if (parsed.type === 'assistant') {
          const c = parsed.message?.content;
          const arr = Array.isArray(c) ? c : [];
          const tb = arr.find((b: { type?: string; text?: string }) => b.type === 'text');
          if (tb?.text?.trim()) msgs.unshift(tb.text.slice(0, 300));
        }
      } catch { /* skip */ }
    }
    if (msgs.length === 0) return;
    const context = msgs.join('\n\n---\n\n');
    const prompt = `Based on these recent messages from a Claude Code agent session, write a single short sentence (max 10 words) summarizing what was accomplished. Be specific and concrete. No preamble.\n\nMessages:\n${context}\n\nOne-line summary:`;
    console.log(`[summary] ${sessionId.slice(0, 8)} generating...`);
    const summary = await runClaudeQuery(prompt, 45_000, () => {
      const s = stateManager.getSession(sessionId);
      return s?.state === 'waiting' && s?.lastMessage === forMessage.slice(0, 300);
    });
    // Only apply if session is still waiting on the same message
    const session = stateManager.getSession(sessionId);
    if (!session || session.state !== 'waiting' || session.lastMessage !== forMessage.slice(0, 300)) {
      console.log(`[summary] ${sessionId.slice(0, 8)} skipped — session moved on`);
      return;
    }
    const clean = summary.trim().replace(/^["']|["']$/g, '');
    console.log(`[summary] ${sessionId.slice(0, 8)} → "${clean}"`);
    const updated = await appendTaskSummary(sessionId, clean);
    stateManager.setCompletionSummaries(sessionId, updated);
    // If manually marked done, auto-accept the generated summary
    const currentSession = stateManager.getSession(sessionId);
    if (currentSession?.completionHintByUser && updated.length > 0) {
      const latest = updated[updated.length - 1];
      stateManager.acceptTask(sessionId, latest.completedAt);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== 'invalidated') console.warn(`[summary] ${sessionId.slice(0, 8)} failed:`, msg);
  }
}

// Wire PtyManager events → broadcast to ALL connected clients
// so any tab can view the PTY terminal
ptyManager.on('output', (sessionId: string, data: string) => {
  // Buffer output for replay on reconnect
  let buf = ptyOutputBuffer.get(sessionId);
  if (!buf) { buf = []; ptyOutputBuffer.set(sessionId, buf); }
  buf.push(Buffer.from(data));
  if (buf.length > PTY_BUFFER_MAX_CHUNKS) buf.splice(0, buf.length - PTY_BUFFER_MAX_CHUNKS);

  const effectiveId = ptyToClaudeId.get(sessionId) ?? sessionId;
  const encoded = Buffer.from(data).toString('base64');
  broadcastRaw({ type: 'terminal:output', sessionId: effectiveId, data: encoded });
});

ptyManager.on('exit', (sessionId: string, code: number) => {
  // Clean up any pending PID entry for this PTY session
  for (const [pid, entry] of pendingPtyByPid) {
    if (entry.ptySessionId === sessionId) {
      pendingPtyByPid.delete(pid);
      break;
    }
  }
  // Clean up any pending resume entry for this PTY session
  for (const [resumeId, entry] of pendingPtyByResumeId) {
    if (entry.ptySessionId === sessionId) {
      pendingPtyByResumeId.delete(resumeId);
      break;
    }
  }
  // Resolve the claude session ID before cleaning maps (client tracks by claude ID, not pty ID)
  const claudeId = ptyToClaudeId.get(sessionId);
  const effectiveId = claudeId ?? sessionId;
  ptyToClaudeId.delete(sessionId);
  // Clean up reverse map
  if (claudeId) {
    claudeToPtyId.delete(claudeId);
  } else {
    for (const [cId, pId] of claudeToPtyId) {
      if (pId === sessionId) { claudeToPtyId.delete(cId); break; }
    }
  }
  // Clean up PTY output buffer
  ptyOutputBuffer.delete(sessionId);
  // Broadcast exit to all clients so any tab can update its state
  broadcastRaw({ type: 'terminal:exit', sessionId: effectiveId, code });
  // Clean up wsSessionMap entries
  for (const [, sessions] of wsSessionMap) {
    sessions.delete(sessionId);
    sessions.delete(effectiveId);
  }
});

ptyManager.on('error', (sessionId: string, message: string) => {
  const msg = { type: 'terminal:error', sessionId, message };
  for (const [ws, sessions] of wsSessionMap) {
    if (sessions.has(sessionId)) {
      sendToClient(ws, msg);
      break;
    }
  }
});

// Global PID-ready handler: populate pendingPtyByPid for ALL PTY spawns (new + resume + auto-resume)
ptyManager.on('pid-ready', (ptySessionId: string, pid: number) => {
  if (!pid) return;
  // Find which ws owns this PTY session
  let ownerWs: WebSocket | null = null;
  for (const [ws, sessions] of wsSessionMap) {
    if (sessions.has(ptySessionId)) {
      ownerWs = ws;
      break;
    }
  }
  // Use null ws sentinel for auto-resume (broadcast to all clients)
  pendingPtyByPid.set(pid, { ptySessionId, ws: (ownerWs ?? null) as unknown as WebSocket });
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

// On WebSocket connection, send current snapshot immediately and set up message routing
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
  ws.send(JSON.stringify({ type: 'log:history', entries: getBuffer() }));
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
      stateManager.setLaunchMethod(sessionId, 'terminal');
      const safeName = sessionName.replace(/"/g, '');
      openTerminalWindow(cwd, `claude --resume ${sessionId} --name "${safeName}"`, `Claude: ${sessionName}`)
        .then(() => sendToClient(ws, { type: 'terminal:external-opened', sessionId }))
        .catch((err) => sendToClient(ws, { type: 'terminal:error', sessionId, message: `Failed to open terminal: ${(err as Error).message}` }));
      return;
    }

    if (type === 'terminal:open-new') {
      const cwd = String(msg.cwd ?? process.cwd());
      const name = msg.name ? String(msg.name) : undefined;
      const cwdName = name || cwd.split(/[\\/]/).pop() || 'New';
      const safeCwdName = cwdName.replace(/"/g, '');
      console.log(`[open-new] cwd=${cwd} name=${cwdName}`);
      openTerminalWindow(cwd, `claude --name "${safeCwdName}"`, `Claude: ${cwdName}`)
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
        injectText(pid, data, false, true)
          .catch((err: Error) => {
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

      console.log(`[inject] session=${sessionId} pid=${targetPid} extraEnter=${extraEnter} text="${text}"`);
      injectText(targetPid, text, extraEnter)
        .then(() => console.log(`[inject] ok pid=${targetPid}`))
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

    if (type === 'terminal:kill') {
      const sessionId = String(msg.sessionId ?? '');
      const resolvedId = claudeToPtyId.get(sessionId) ?? sessionId;
      // Get the PID before killing so we can find the Claude session record
      const ptyPid = ptyManager.getPid(resolvedId);
      ptyManager.kill(resolvedId);
      // Clean up PTY ↔ Claude ID maps (kill() bypasses the onExit handler)
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

// Debug endpoint: spawn a test session
app.post('/api/debug/spawn', express.json(), (req, res) => {
  const cwd = String(req.body?.cwd ?? process.cwd());
  const name = req.body?.name ? String(req.body.name) : undefined;
  const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stateManager.trackPendingPtySpawn(cwd);
  const args = ['--name', `${name ? name + '___OVR:' : '___OVR:'}${ptySessionId}`];
  try {
    ptyManager.spawn(ptySessionId, cwd, 80, 24, args);
    log('pty:started', 'PTY test spawn', { sessionId: ptySessionId });
    res.json({ ok: true, ptySessionId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Debug endpoint: clone a session
app.post('/api/debug/clone', express.json(), (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '');
  const session = stateManager.getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'session not found' }); return; }
  const cloneName = String(req.body?.name ?? `Clone (test)`);
  const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stateManager.trackPendingPtySpawn(session.cwd);
  pendingCloneInfo.set(ptySessionId, { name: cloneName, originalSessionId: sessionId });
  try {
    ptyManager.spawn(ptySessionId, session.cwd, 80, 24, ['--resume', sessionId, '--fork-session', '--name', `${cloneName}___OVR:${ptySessionId}`]);
    log('pty:started', 'PTY test clone', { sessionId: ptySessionId, sessionName: cloneName });
    res.json({ ok: true, ptySessionId, cloneName });
  } catch (err) {
    pendingCloneInfo.delete(ptySessionId);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Debug endpoint: dump current state snapshot
app.get('/api/debug/state', (_req, res) => {
  const snapshot = stateManager.getSnapshot();
  const sessions = snapshot.rooms.flatMap(r => r.sessions);
  res.json({
    sessionCount: sessions.length,
    sessions: sessions.map(s => ({ sessionId: s.sessionId, name: s.proposedName ?? '', cwd: s.cwd, state: s.state, isWorker: s.isWorker, pid: s.pid, launchMethod: s.launchMethod })),
    ptyToClaudeId: Object.fromEntries(ptyToClaudeId),
    claudeToPtyId: Object.fromEntries(claudeToPtyId),
    pendingPtyByPid: Object.fromEntries([...pendingPtyByPid].map(([pid, entry]) => [pid, entry.ptySessionId])),
    pendingPtyByResumeId: Object.fromEntries([...pendingPtyByResumeId].map(([id, entry]) => [id, entry.ptySessionId])),
  });
});

// Respond to permission prompt for an external session
app.post('/api/sessions/:sessionId/inject', express.json(), (req, res) => {
  void (async () => {
    const { sessionId } = req.params;
    const { text } = req.body as { text?: string };
    if (!text) { res.status(400).json({ error: 'text required' }); return; }

    const session = stateManager.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }

    console.log(`[approve] sessionId=${sessionId} pid=${session.pid} needsPermission=${session.needsPermission} text=${JSON.stringify(text)}`);
    try {
      // Always use injectText (TryPipeInject → TryConsoleInput fallback).
      // TryPipeInject writes directly to the stdin pipe which works in ConPTY (Windows Terminal).
      // TryConsoleInput writes to the console input buffer which ConPTY ignores.
      await injectText(session.pid, text);
      console.log(`[approve] injectText done pid=${session.pid}`);
      // Proactively clear the flag so the UI updates immediately
      stateManager.setNeedsPermission(sessionId, false);
      res.json({ ok: true });
    } catch (err) {
      console.log(`[approve] error: ${String(err)}`);
      res.status(500).json({ error: String(err) });
    }
  })();
});

// Kill the process for a session
app.post('/api/sessions/:sessionId/kill-process', (req, res) => {
  const { sessionId } = req.params;
  const session = stateManager.getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  try {
    execSync(`taskkill /F /T /PID ${session.pid}`, { stdio: 'ignore' });
    const killedName = session.proposedName ?? sessionId.slice(0, 8);
    log('session:killed', 'Process killed', { sessionId, sessionName: killedName, extra: 'PID ' + session.pid });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Kill failed' });
  }
});

// Manually mark a session as done
app.post('/api/sessions/:sessionId/mark-done', (req, res) => {
  const { sessionId } = req.params;
  const ok = stateManager.markDoneByUser(sessionId);
  if (!ok) { res.status(404).json({ error: 'session not found or idle' }); return; }
  const session = stateManager.getSession(sessionId);
  if (session?.lastMessage) {
    void generateCompletionSummary(sessionId, session.lastMessage);
  }
  res.json({ ok: true });
});

// Accept a done session (user reviewed and confirmed result)
app.post('/api/sessions/:sessionId/accept', (req, res) => {
  const { sessionId } = req.params;
  const ok = stateManager.acceptSession(sessionId);
  if (!ok) { res.status(404).json({ error: 'session not found' }); return; }
  res.json({ ok: true });
});

// Accept a specific task summary (per-task review)
app.post('/api/sessions/:sessionId/accept-task', express.json(), (req, res) => {
  const { sessionId } = req.params;
  const { completedAt } = req.body as { completedAt?: string };
  if (!completedAt) { res.status(400).json({ error: 'completedAt required' }); return; }
  const ok = stateManager.acceptTask(sessionId, completedAt);
  if (!ok) { res.status(404).json({ error: 'session or task not found' }); return; }
  res.json({ ok: true });
});

// Screen buffer endpoint: reads the console screen buffer of a session's process
app.get('/api/sessions/:sessionId/screen', async (req, res) => {
  const session = stateManager.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.state === 'closed') {
    res.status(400).json({ error: 'Session is closed' });
    return;
  }
  try {
    const { readScreen } = await import('./consoleInjector.js');
    const text = await readScreen(session.pid);
    res.json({ text: text ?? '', pid: session.pid, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Summarize endpoint: reads transcript, calls claude haiku to produce a bullet-point summary
app.post('/api/summarize', express.json({ limit: '1mb' }), (req, res) => {
  void (async () => {
    const { sessionId } = req.body as { sessionId: string };
    if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return; }

    const transcriptPath = findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) { res.json({ summary: 'No transcript found for this session.' }); return; }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Extract up to 20 user/assistant messages (scanning from end to get the most recent)
      const messages: Array<{ role: string; content: string }> = [];
      for (let i = lines.length - 1; i >= 0 && messages.length < 20; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as {
            type?: string;
            message?: { content?: string | Array<{ type?: string; text?: string }> };
          };
          if (parsed.type === 'user' || parsed.type === 'assistant') {
            const rawContent = parsed.message?.content;
            let text: string | undefined;
            if (typeof rawContent === 'string') {
              text = rawContent;
            } else if (Array.isArray(rawContent)) {
              const textBlock = rawContent.find((b) => (b as { type?: string }).type === 'text');
              text = (textBlock as { text?: string })?.text;
            }
            if (text?.trim()) {
              messages.unshift({ role: parsed.type, content: text.slice(0, 600) });
            }
          }
        } catch { /* skip */ }
      }

      if (messages.length < 2) {
        res.json({ summary: 'Not enough conversation to summarize.' });
        return;
      }

      const conversationText = messages
        .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
        .join('\n\n');

      const prompt = `Summarize this Claude Code agent session in 3-5 bullet points. Focus on high-level goals and what was accomplished — not implementation details. Be specific and concise.\n\nConversation:\n${conversationText}\n\nRespond with bullet points only (use • prefix), no preamble.`;

      const summary = await runClaudeQuery(prompt, 60_000);

      res.json({ summary: summary || 'No summary generated.' });
    } catch (err) {
      console.error('[summarize] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  })();
});

// Open file endpoint: opens a file path in a JetBrains IDE (Windows) or default system editor
app.post('/api/open-file', express.json(), (req, res) => {
  const { path: filePath, ideName } = req.body as { path: string; ideName?: string };
  if (!filePath || typeof filePath !== 'string') {
    res.status(400).json({ error: 'path required' });
    return;
  }
  let cmd: string;
  if (process.platform === 'win32') {
    const ideCmd = (() => {
      const name = (ideName ?? '').toLowerCase();
      if (name.includes('pycharm')) return 'pycharm';
      if (name.includes('webstorm')) return 'webstorm';
      return 'idea';
    })();
    const toolboxScripts = join(process.env.LOCALAPPDATA ?? '', 'JetBrains', 'Toolbox', 'scripts');
    const scriptPath = join(toolboxScripts, `${ideCmd}.cmd`);
    cmd = fs.existsSync(scriptPath)
      ? `"${scriptPath}" "${filePath}"`
      : `${ideCmd} "${filePath}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${filePath}"`;
  } else {
    cmd = `xdg-open "${filePath}"`;
  }
  exec(cmd, (err) => {
    if (err) res.status(500).json({ error: err.message });
    else res.json({ ok: true });
  });
});

// Paste image endpoint: receives base64-encoded image, writes to tmp file, returns path + preview URL
app.post('/api/paste-image', express.json({ limit: '10mb' }), (req, res) => {
  const { base64, ext } = req.body as { base64: string; ext: string };
  const tmpDir = os.tmpdir();
  const filename = `overlord-paste-${Date.now()}.${ext}`;
  const filepath = join(tmpDir, filename);
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
  res.json({
    path: filepath,
    previewUrl: `data:image/${ext};base64,${base64}`,
  });
});

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

