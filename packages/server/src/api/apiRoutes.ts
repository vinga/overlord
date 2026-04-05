import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { exec, execSync } from 'child_process';
import express from 'express';
import type { Express } from 'express';
import type { WebSocket } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe } from '../pty/pipeInjector.js';
import { findTranscriptPathAnywhere } from '../session/transcriptReader.js';
import { runClaudeQuery } from '../ai/claudeQuery.js';
import { log } from '../logger.js';

export interface PtyMaps {
  ptyToClaudeId: Map<string, string>;
  claudeToPtyId: Map<string, string>;
  pendingPtyByPid: Map<number, { ptySessionId: string; ws: WebSocket }>;
  pendingPtyByResumeId: Map<string, { ptySessionId: string; ws: WebSocket; timestamp: number }>;
  pendingCloneInfo: Map<string, { name: string; originalSessionId: string }>;
}

export function registerApiRoutes(
  app: Express,
  stateManager: StateManager,
  ptyManager: PtyManager,
  ptyMaps: PtyMaps,
  bridgeSessions: Set<string>,
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void,
  generateCompletionSummary: (sessionId: string, forMessage: string) => Promise<void>,
): void {
  const { ptyToClaudeId, claudeToPtyId, pendingPtyByPid, pendingPtyByResumeId, pendingCloneInfo } = ptyMaps;

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
        // Try bridge pipe first, fall back to ConPTY injection
        let injected = false;
        if (bridgeSessions.has(sessionId)) {
          injected = await injectViaPipe(sessionId, text);
          if (injected) console.log(`[approve] pipe inject done session=${sessionId}`);
        }
        if (!injected) {
          await injectText(session.pid, text);
          console.log(`[approve] injectText done pid=${session.pid}`);
        }
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
      const { readScreen } = await import('../pty/consoleInjector.js');
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
}
