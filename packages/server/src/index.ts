import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import { StateManager } from './stateManager.js';
import { SessionWatcher } from './sessionWatcher.js';
import { ProcessChecker } from './processChecker.js';
import { PtyManager } from './ptyManager.js';
import { injectText } from './consoleInjector.js';
import { findTranscriptPathAnywhere } from './transcriptReader.js';
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

// Setup state manager
const stateManager = new StateManager(() => {
  broadcast(stateManager.getSnapshot());
});

// Setup session watcher
const sessionWatcher = new SessionWatcher();
sessionWatcher.on('added', (raw) => stateManager.addOrUpdate(raw));
sessionWatcher.on('changed', (raw) => stateManager.addOrUpdate(raw));
sessionWatcher.on('removed', (sessionId: string) => stateManager.remove(sessionId));
sessionWatcher.start();

// Setup process checker
const processChecker = new ProcessChecker();
processChecker.start((pids) => {
  stateManager.updateAlivePids(pids);
});

// Watch project transcripts for real-time updates
const projectsDir = join(os.homedir(), '.claude', 'projects');
chokidar
  .watch(projectsDir, {
    depth: 4,
    ignoreInitial: true,
  })
  .on('change', (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    const parts = filePath.split(/[\\/]/);
    // Subagent path: .../{slug}/{sessionId}/subagents/{agentId}.jsonl
    // Main path:     .../{slug}/{sessionId}.jsonl
    const subagentsIdx = parts.indexOf('subagents');
    if (subagentsIdx !== -1) {
      // Refresh the parent session
      const sessionId = parts[subagentsIdx - 1];
      if (sessionId) stateManager.refreshTranscript(sessionId);
    } else {
      const basename = parts.pop() ?? '';
      const sessionId = basename.replace(/\.jsonl$/, '');
      if (sessionId) stateManager.refreshTranscript(sessionId);
    }
  });

// Periodic state refresh — re-evaluate all session states every 3s
// (smallest state threshold is 3s, so polling must be at least that frequent)
setInterval(() => {
  for (const sessionId of stateManager.getAllSessionIds()) {
    stateManager.refreshTranscript(sessionId);
  }
}, 3_000);

// Wire PtyManager events → send to the owning WebSocket client
ptyManager.on('output', (sessionId: string, data: string) => {
  const encoded = Buffer.from(data).toString('base64');
  const msg = { type: 'terminal:output', sessionId, data: encoded };
  for (const [ws, sessions] of wsSessionMap) {
    if (sessions.has(sessionId)) {
      sendToClient(ws, msg);
      break;
    }
  }
});

ptyManager.on('exit', (sessionId: string, code: number) => {
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

  // 3. Always explicitly remove from state (don't rely on chokidar firing)
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

      const sessions = wsSessionMap.get(ws);
      if (sessions) sessions.add(ptySessionId);

      sendToClient(ws, { type: 'terminal:spawned', sessionId: ptySessionId, pid: 0 });
      try {
        ptyManager.spawn(ptySessionId, cwd, cols, rows, ['--resume', resumeSessionId]);
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
      ptyManager.write(sessionId, data);
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
      ptyManager.resize(sessionId, cols, rows);
      return;
    }

    if (type === 'terminal:kill') {
      const sessionId = String(msg.sessionId ?? '');
      // Get the PID before killing so we can find the Claude session record
      const ptyPid = ptyManager.getPid(sessionId);
      ptyManager.kill(sessionId);
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

// Summarize endpoint: reads transcript, calls claude haiku to produce a bullet-point summary
app.post('/api/summarize', express.json({ limit: '1mb' }), (req, res) => {
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

    // Resolve claude binary (same logic as PtyManager)
    let claudeBin = 'claude';
    try {
      claudeBin = execSync('where claude', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    } catch {
      claudeBin = join(os.homedir(), '.local', 'bin', 'claude.exe');
    }

    const result = spawnSync(claudeBin, ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const errMsg = result.stderr?.trim() || `claude exited with code ${String(result.status)}`;
      throw new Error(errMsg);
    }

    const summary = result.stdout.trim();
    res.json({ summary: summary || 'No summary generated.' });
  } catch (err) {
    console.error('[summarize] error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
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
