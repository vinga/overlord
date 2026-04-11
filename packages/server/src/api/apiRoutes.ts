import * as fs from 'fs';
import * as os from 'os';
import { join, resolve, dirname, basename } from 'path';
import { exec, execSync } from 'child_process';
import express from 'express';
import type { Express } from 'express';
import type { WebSocket } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe, bridgeManager, getBridgePath } from '../pty/pipeInjector.js';
import { injectViaMac } from '../pty/macInjector.js';
import { findTranscriptPathAnywhere, readActivityBefore } from '../session/transcriptReader.js';
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
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void,
  generateCompletionSummary: (sessionId: string, forMessage: string) => Promise<void>,
  ptyOutputBuffer: Map<string, Buffer[]>,
  generateTaskTitle?: (sessionId: string, taskId: string) => Promise<void>,
): void {
  const { ptyToClaudeId, claudeToPtyId, pendingPtyByPid, pendingPtyByResumeId, pendingCloneInfo } = ptyMaps;

  // Server info endpoint — returns bridge binary path and platform
  app.get('/api/info', (_req, res) => {
    res.json({ bridgePath: getBridgePath(), platform: process.platform });
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
      sessions: sessions.map(s => ({ sessionId: s.sessionId, name: s.proposedName ?? '', cwd: s.cwd, state: s.state, isWorker: s.isWorker, pid: s.pid, sessionType: s.sessionType, replacedBy: s.replacedBy })),
      ptyToClaudeId: Object.fromEntries(ptyToClaudeId),
      claudeToPtyId: Object.fromEntries(claudeToPtyId),
      pendingPtyByPid: Object.fromEntries([...pendingPtyByPid].map(([pid, entry]) => [pid, entry.ptySessionId])),
      pendingPtyByResumeId: Object.fromEntries([...pendingPtyByResumeId].map(([id, entry]) => [id, entry.ptySessionId])),
      bridgeSessions: Object.keys(stateManager.deriveBridgeRegistry()),
      bridgeConnected: Object.keys(stateManager.deriveBridgeRegistry()).map(id => ({ id: id.slice(0, 8), connected: bridgeManager.isConnected(id), pipeAddr: bridgeManager.getPipeAddr(id) })),
    });
  });

  // Respond to permission prompt for an external session
  app.post('/api/sessions/:sessionId/inject', express.json(), (req, res) => {
    void (async () => {
      const { sessionId } = req.params;
      const { text, raw } = req.body as { text?: string; raw?: boolean };
      if (!text) { res.status(400).json({ error: 'text required' }); return; }

      const session = stateManager.getSession(sessionId);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }

      console.log(`[approve] sessionId=${sessionId} pid=${session.pid} needsPermission=${session.needsPermission} raw=${raw} text=${JSON.stringify(text)}`);
      // /clear: wipe activity feed BEFORE injecting to avoid a race where the session
      // watcher fires markClosed() before we get back from await, making the guard skip.
      if (text.trimStart().startsWith('/clear')) {
        stateManager.clearActivityFeed(sessionId);
        const sess = stateManager.getSession(sessionId);
        if (sess) stateManager.markPendingClearReplacement(sessionId, sess.cwd);
      }
      try {
        // Try bridge pipe first, then macOS Terminal.app, then ConPTY injection
        let injected = false;
        if (stateManager.isBridge(sessionId)) {
          injected = await injectViaPipe(sessionId, text);
          if (injected) console.log(`[approve] pipe inject done session=${sessionId}`);
        }
        if (!injected && process.platform === 'darwin') {
          injected = await injectViaMac(session.pid, text, false);
          if (injected) console.log(`[approve] mac inject done pid=${session.pid}`);
        }
        if (!injected && process.platform !== 'darwin') {
          await injectText(session.pid, text, false, raw === true);
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

  // Cycle permission mode (Shift+Tab) and immediately read screen to update chip
  app.post('/api/sessions/:sessionId/cycle-permission-mode', (req, res) => {
    void (async () => {
      const { sessionId } = req.params;
      const session = stateManager.getSession(sessionId);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }

      try {
        // Inject Shift+Tab to cycle the mode
        if (stateManager.isBridge(sessionId)) {
          await injectViaPipe(sessionId, '\x1b[Z');
        } else if (process.platform === 'darwin') {
          await injectViaMac(session.pid, '\x1b[Z', false);
        } else {
          await injectText(session.pid, '\x1b[Z', false, true);
        }

        // Wait for the TUI to update, then read screen
        await new Promise(r => setTimeout(r, 500));
        let text: string | null = null;
        const { claudeToPtyId } = ptyMaps;
        const bufKey = stateManager.isBridge(sessionId) ? sessionId : (claudeToPtyId.get(sessionId) ?? null);
        if (bufKey) {
          const chunks = ptyOutputBuffer.get(bufKey);
          if (chunks && chunks.length > 0) {
            const raw = Buffer.concat(chunks.slice(-50)).toString('utf8');
            const stripped = raw
              .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
              .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
              .replace(/\x1b[^[\]]/g, '')
              .replace(/\x1b/g, '')
              .replace(/[^\x20-\x7e\n\t\r]/g, '');
            text = stripped.split('\n').map(line => {
              const parts = line.split('\r');
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i].trim()) return parts[i];
              }
              return parts[parts.length - 1];
            }).join('\n').trim() || null;
          }
        } else {
          const { readScreen } = await import('../pty/consoleInjector.js');
          text = await readScreen(session.pid);
        }

        // Detect new mode from screen text
        const PERMISSION_MODE_PATTERNS: Array<{ pattern: RegExp; mode: string }> = [
          { pattern: /bypass permissions on/i, mode: 'bypassPermissions' },
          { pattern: /accept edits on/i, mode: 'acceptEdits' },
          { pattern: /plan mode on/i, mode: 'plan' },
        ];
        let newMode: string | undefined;
        if (text) {
          for (const { pattern, mode } of PERMISSION_MODE_PATTERNS) {
            if (pattern.test(text)) { newMode = mode; break; }
          }
          if (!newMode) newMode = 'default';
        }

        if (newMode !== undefined) {
          stateManager.setPermissionMode(sessionId, newMode);
        }

        res.json({ ok: true, mode: newMode });
      } catch (err) {
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
      try { execSync(`pkill -P ${session.pid}`, { stdio: 'ignore' }); } catch { /* no children */ }
      execSync(`kill -9 ${session.pid}`, { stdio: 'ignore' });
      const killedName = session.proposedName ?? sessionId.slice(0, 8);
      log('session:killed', 'Process killed', { sessionId, sessionName: killedName, extra: 'PID ' + session.pid });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Kill failed' });
    }
  });

  // Delete a session from state (removes from UI; does not kill the process)
  app.delete('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!stateManager.getSession(sessionId)) { res.status(404).json({ error: 'Session not found' }); return; }
    deleteSession(sessionId, undefined, 'session:delete (REST)');
    res.json({ ok: true });
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

  // Regenerate request summary for a session
  app.post('/api/sessions/:sessionId/regenerate-summary', (req, res) => {
    const { sessionId } = req.params;
    const session = stateManager.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    if (generateTaskTitle && session.currentTask) {
      void generateTaskTitle(sessionId, session.currentTask.taskId);
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

  // Screen buffer endpoint: reads the console screen buffer of a session's process.
  // For bridge sessions, returns the last portion of the pipe output buffer (ANSI-stripped).
  app.get('/api/sessions/:sessionId/screen', async (req, res) => {
    const { sessionId } = req.params;
    const session = stateManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.state === 'closed') {
      res.status(400).json({ error: 'Session is closed' });
      return;
    }
    // Bridge sessions: serve from ptyOutputBuffer (ANSI-stripped)
    if (stateManager.isBridge(sessionId)) {
      const chunks = ptyOutputBuffer.get(sessionId);
      if (!chunks || chunks.length === 0) {
        res.json({ text: '', sessionId });
        return;
      }
      const raw = Buffer.concat(chunks.slice(-50)).toString('utf8');
      // Strip ANSI and process carriage returns
      const stripped = raw
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
        .replace(/\x1b[^[\]]/g, '')
        .replace(/\x1b/g, '')
        .replace(/[^\x20-\x7e\n\t\r]/g, '');
      const text = stripped.split('\n').map(line => {
        const parts = line.split('\r');
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i].trim()) return parts[i];
        }
        return parts[parts.length - 1];
      }).join('\n').trim();
      res.json({ text, sessionId });
      return;
    }
    try {
      const { readScreen } = await import('../pty/consoleInjector.js');
      const text = await readScreen(session.pid);
      res.json({ text: text ?? '', pid: session.pid, sessionId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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

  // Serve pasted images by path (only overlord-paste-* files from temp dir)
  app.get('/api/paste-image', (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath || !basename(filePath).startsWith('overlord-paste-')) {
      res.status(403).send('Forbidden');
      return;
    }
    try {
      if (!fs.existsSync(filePath)) { res.status(404).send('Not found'); return; }
      const ext = filePath.split('.').pop()?.toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.send(fs.readFileSync(filePath));
    } catch { res.status(500).send('Error'); }
  });

  // Directory browser for new-folder spawn dialog
  app.get('/api/directories', (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const resolved = requestedPath ? resolve(requestedPath) : process.cwd();
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        res.status(400).json({ error: 'Not a valid directory' });
        return;
      }
      const parentDir = dirname(resolved);
      const parent = parentDir !== resolved ? parentDir : null;
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      res.json({ current: resolved, parent, dirs });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // Return activity feed items before a given timestamp (for search "load context" feature)
  app.get('/api/sessions/:sessionId/activity-before', (req, res) => {
    const { sessionId } = req.params;
    const { timestamp, limit } = req.query;
    if (!timestamp || typeof timestamp !== 'string') {
      res.status(400).json({ error: 'timestamp query param required' });
      return;
    }
    const transcriptPath = findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) {
      res.json({ items: [] });
      return;
    }
    try {
      const items = readActivityBefore(transcriptPath, timestamp, Number(limit) || 50);
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
