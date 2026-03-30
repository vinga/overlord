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
import { findTranscriptPathAnywhere } from './transcriptReader.js';
import { appendTaskSummary } from './taskStorage.js';
import { runClaudeQuery } from './claudeQuery.js';
import type { OfficeSnapshot } from './types.js';

// Per-session debounce timers for active task label generation
const activeTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

// Map pty-xxx sessionId → real claudeSessionId after linking
const ptyToClaudeId = new Map<string, string>();
// Reverse: claudeSessionId → pty-xxx sessionId (for input/resize routing)
const claudeToPtyId = new Map<string, string>();

// Helper: send a typed message to a specific client
function sendToClient(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Broadcast snapshot to all connected WS clients (wrapped with type field)
function broadcast(snapshot: OfficeSnapshot): void {
  const payload = JSON.stringify({ type: 'snapshot', ...snapshot });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
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

// Setup state manager
const stateManager = new StateManager(() => {
  broadcast(stateManager.getSnapshot());
});

// Start permission checker (Windows-only; no-op on other platforms)
startPermissionChecker(stateManager);

// Setup session watcher
const sessionWatcher = new SessionWatcher();
sessionWatcher.on('added', (raw) => {
  const { isNewWaiting, lastMessage } = stateManager.addOrUpdate(raw);
  if (isNewWaiting && lastMessage && raw.kind !== 'haiku-worker') void classifyCompletion(raw.sessionId, lastMessage);
  // Link PTY session to real Claude session by PID
  if (raw.pid && pendingPtyByPid.has(raw.pid)) {
    const entry = pendingPtyByPid.get(raw.pid)!;
    pendingPtyByPid.delete(raw.pid);
    // Add claudeSessionId to wsSessionMap so output/exit are routed correctly
    const wsSessions = wsSessionMap.get(entry.ws);
    if (wsSessions) wsSessions.add(raw.sessionId);
    // Also add ptyToClaudeId mapping for output rerouting
    ptyToClaudeId.set(entry.ptySessionId, raw.sessionId);
    claudeToPtyId.set(raw.sessionId, entry.ptySessionId);
    sendToClient(entry.ws, { type: 'terminal:linked', ptySessionId: entry.ptySessionId, claudeSessionId: raw.sessionId });
    stateManager.setLaunchMethod(raw.sessionId, 'overlord-pty');
  }
  // Detect session replacement: same PID as an existing closed session (e.g. Claude Code's /clear)
  if (raw.pid && raw.pid > 0 && !pendingPtyByPid.has(raw.pid)) {
    const oldSession = stateManager.findSessionByPid(raw.pid, raw.sessionId);
    if (oldSession && oldSession.state === 'closed') {
      broadcastRaw({ type: 'session:replaced', oldSessionId: oldSession.sessionId, newSessionId: raw.sessionId });
    }
  }
});
sessionWatcher.on('changed', (raw) => stateManager.addOrUpdate(raw));
sessionWatcher.on('removed', (sessionId: string) => {
  const session = stateManager.getSession(sessionId);
  if (session?.isWorker) stateManager.remove(sessionId);
  else stateManager.markClosed(sessionId);
});
sessionWatcher.start();

// Load closed sessions from transcripts on startup
stateManager.loadClosedSessionsFromTranscripts().catch(err => {
  console.warn('[startup] failed to load closed sessions from transcripts:', err);
});

// Setup process checker
const processChecker = new ProcessChecker();
processChecker.start((pids) => {
  stateManager.updateAlivePids(pids);
});

// Watch project transcripts for real-time updates
const projectsDir = join(os.homedir(), '.claude', 'projects');
function handleTranscriptFile(filePath: string): void {
  if (!filePath.endsWith('.jsonl')) return;
  const parts = filePath.split(/[\\/]/);
  // Subagent path: .../{slug}/{sessionId}/subagents/{agentId}.jsonl
  // Main path:     .../{slug}/{sessionId}.jsonl
  const subagentsIdx = parts.indexOf('subagents');
  if (subagentsIdx !== -1) {
    const sessionId = parts[subagentsIdx - 1];
    if (sessionId) stateManager.refreshTranscript(sessionId);
  } else {
    const basename = parts.pop() ?? '';
    const sessionId = basename.replace(/\.jsonl$/, '');
    if (sessionId) stateManager.refreshTranscript(sessionId);
  }
}
chokidar
  .watch(projectsDir, {
    depth: 4,
    ignoreInitial: true,
  })
  .on('add', handleTranscriptFile)
  .on('change', handleTranscriptFile);

// Periodic state refresh — re-evaluate all session states every 3s
// (smallest state threshold is 3s, so polling must be at least that frequent)
setInterval(() => {
  for (const sessionId of stateManager.getAllSessionIds()) {
    const session = stateManager.getSession(sessionId);
    if (session?.state === 'closed') continue;
    const { becameWaiting, lastMessage, becameWorking, leftWorking } = stateManager.refreshTranscript(sessionId);
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

// Wire PtyManager events → send to the owning WebSocket client
ptyManager.on('output', (sessionId: string, data: string) => {
  const effectiveId = ptyToClaudeId.get(sessionId) ?? sessionId;
  const encoded = Buffer.from(data).toString('base64');
  const msg = { type: 'terminal:output', sessionId: effectiveId, data: encoded };
  for (const [ws, sessions] of wsSessionMap) {
    if (sessions.has(sessionId) || sessions.has(effectiveId)) {
      sendToClient(ws, msg);
    }
  }
});

ptyManager.on('exit', (sessionId: string, code: number) => {
  // Clean up any pending PID entry for this PTY session
  for (const [pid, entry] of pendingPtyByPid) {
    if (entry.ptySessionId === sessionId) {
      pendingPtyByPid.delete(pid);
      break;
    }
  }
  ptyToClaudeId.delete(sessionId);
  // Clean up reverse map
  for (const [claudeId, ptyId] of claudeToPtyId) {
    if (ptyId === sessionId) { claudeToPtyId.delete(claudeId); break; }
  }
  const msg = { type: 'terminal:exit', sessionId, code };
  for (const [ws, sessions] of wsSessionMap) {
    if (sessions.has(sessionId)) {
      sendToClient(ws, msg);
      sessions.delete(sessionId);
      break;
    }
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

// Shared helper: kill a Claude session by PID and remove its session file + state
function deleteSession(sessionId: string, pid?: number): void {
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

  // 6. Always explicitly remove from state (don't rely on chokidar firing)
  stateManager.remove(sessionId);
  console.log(`[deleteSession] removed ${sessionId} from state`);
}

// On WebSocket connection, send current snapshot immediately and set up message routing
wss.on('connection', (ws) => {
  // Register this client in the session map
  wsSessionMap.set(ws, new Set());

  const snapshot = stateManager.getSnapshot();
  ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }));

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
      // Generate a unique sessionId for this PTY session
      const sessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const sessions = wsSessionMap.get(ws);
      if (sessions) sessions.add(sessionId);

      sendToClient(ws, { type: 'terminal:spawned', sessionId, pid: 0 });
      // Spawn after notifying client of sessionId (pid will be 0 until we have it)
      try {
        ptyManager.spawn(sessionId, cwd, cols, rows);
        const pid = ptyManager.getPid(sessionId);
        if (pid) pendingPtyByPid.set(pid, { ptySessionId: sessionId, ws });
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

      const sessions = wsSessionMap.get(ws);
      if (sessions) sessions.add(ptySessionId);

      sendToClient(ws, { type: 'terminal:spawned', sessionId: ptySessionId, pid: 0 });
      try {
        ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', resumeSessionId]);
        const pid = ptyManager.getPid(ptySessionId);
        if (pid) pendingPtyByPid.set(pid, { ptySessionId: ptySessionId, ws });
      } catch (err) {
        sendToClient(ws, {
          type: 'terminal:error',
          sessionId: ptySessionId,
          message: `Resume failed: ${(err as Error).message}`,
        });
      }
      return;
    }

    if (type === 'terminal:input') {
      const sessionId = String(msg.sessionId ?? '');
      const data = String(msg.data ?? '');
      ptyManager.write(claudeToPtyId.get(sessionId) ?? sessionId, data);
      return;
    }

    if (type === 'terminal:inject') {
      const sessionId = String(msg.sessionId ?? '');
      const text = String(msg.text ?? '');
      const extraEnter = Boolean(msg.extraEnter);

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
      const sessions = wsSessionMap.get(ws);
      if (sessions) sessions.delete(sessionId);

      // Find the real Claude session by PID and delete it
      if (ptyPid) {
        const snap = stateManager.getSnapshot();
        for (const room of snap.rooms) {
          for (const session of room.sessions) {
            if (session.pid === ptyPid) {
              deleteSession(session.sessionId, ptyPid);
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

      deleteSession(sessionId, targetPid);
      return;
    }
  });

  ws.on('close', () => {
    // Kill all PTY sessions owned by this client
    const sessions = wsSessionMap.get(ws);
    if (sessions) {
      for (const sessionId of sessions) {
        ptyManager.kill(sessionId);
      }
    }
    wsSessionMap.delete(ws);
  });
});

// Debug endpoint: dump current state snapshot
app.get('/api/debug/state', (_req, res) => {
  const snapshot = stateManager.getSnapshot();
  const sessions = snapshot.rooms.flatMap(r => r.sessions);
  res.json({ sessionCount: sessions.length, sessions: sessions.map(s => ({ sessionId: s.sessionId, name: s.proposedName ?? '', cwd: s.cwd, state: s.state, isWorker: s.isWorker })) });
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
