import * as fs from 'fs';
import * as os from 'os';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { sessionStore, scrubReplacedBy } from '../session/sessionStore.js';
import { getCachedJiraTitle, getJiraCacheStats } from '../session/jiraTitleCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { exec, execSync } from 'child_process';
import express from 'express';
import type { Express } from 'express';
import type { WebSocket } from 'ws';
import type { StateManager } from '../session/stateManager.js';
import type { PtyManager } from '../pty/ptyManager.js';
import { injectText } from '../pty/consoleInjector.js';
import { injectViaPipe, bridgeManager, getBridgePath } from '../pty/pipeInjector.js';
import { detectModeFromText } from '../session/modeDetect.js';
import { injectViaMac } from '../pty/macInjector.js';
import { findTranscriptPathAnywhere, findTranscriptPath, readActivityBefore, readTranscriptState } from '../session/transcriptReader.js';
import { runClaudeQuery } from '../ai/claudeQuery.js';
import { readGitStatus } from '../git/gitStatus.js';
import { globalSettingsStore } from '../session/globalSettingsStore.js';
import { archiveManager } from '../archive/archiveManager.js';
import { computeArchiveStats } from '../archive/archiveStats.js';
import { getBrainContext, invalidateBrainCache } from '../brain/brainContext.js';
import { readRoomConfig, writeRoomConfig } from '../session/roomConfig.js';
import { log } from '../logger.js';
import { artifactStore } from '../artifacts/artifactStore.js';
import type { Artifact, ArtifactChangedEvent, ArtifactKind, ArtifactStatus } from '../artifacts/types.js';

export interface PtyMaps {
  ovrToPty: Map<string, string>;     // ovrId → ptySessionId
  ptyToOvr: Map<string, string>;     // ptySessionId → ovrId
  linkageTracker: import('../session/ptyLinkageTracker.js').PtyLinkageTracker;
}

export function registerApiRoutes(
  app: Express,
  stateManager: StateManager,
  ptyManager: PtyManager,
  ptyMaps: PtyMaps,
  deleteSession: (sessionId: string, pid?: number, reason?: string) => void,
  ptyOutputBuffer: Map<string, Buffer[]>,
  broadcastRaw?: (msg: object) => void,
): void {
  const { ovrToPty, ptyToOvr, linkageTracker } = ptyMaps;

  // Server info endpoint — returns bridge binary path and platform
  app.get('/api/info', (_req, res) => {
    res.json({ bridgePath: getBridgePath(), platform: process.platform });
  });

  app.get('/api/stats', (_req, res) => {
    res.json(stateManager.getStats());
  });

  app.get('/api/settings', (_req, res) => {
    const s = globalSettingsStore.get();
    res.json({
      ...s,
      jiraApiToken: s.jiraApiToken ? '***' : '',
    });
  });

  app.patch('/api/settings', express.json(), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    if (typeof body.disableBackgroundLLM === 'boolean') {
      partial.disableBackgroundLLM = body.disableBackgroundLLM;
    }
    if (typeof body.jiraBaseUrl === 'string') {
      partial.jiraBaseUrl = body.jiraBaseUrl;
    }
    if (typeof body.jiraProjects === 'string') {
      partial.jiraProjects = body.jiraProjects;
    }
    if (typeof body.jiraEmail === 'string') {
      partial.jiraEmail = body.jiraEmail;
    }
    // "***" is the sentinel we return from GET — treat it as "leave unchanged".
    if (typeof body.jiraApiToken === 'string' && body.jiraApiToken !== '***') {
      partial.jiraApiToken = body.jiraApiToken;
    }
    const next = globalSettingsStore.patch(partial);
    res.json({
      ...next,
      jiraApiToken: next.jiraApiToken ? '***' : '',
    });
  });

  // Git status for a room cwd. Only allowed for cwds matching a known room
  // to prevent arbitrary path probing from the browser.
  app.get('/api/git/status', async (req, res) => {
    const cwd = String(req.query.cwd ?? '');
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    if (!stateManager.isKnownRoomCwd(cwd)) return res.status(404).json({ error: 'unknown cwd' });
    const status = await readGitStatus(cwd, stateManager.getPrCache());
    if (!status) return res.status(404).json({ error: 'not a git repo' });
    res.json(status);
  });

  // PR metadata + checks for a room cwd — lazy endpoint, awaits gh fetches.
  // Separated from /api/git/status so the tooltip can render local git data
  // immediately while PR/checks stream in independently.
  app.get('/api/git/pr', async (req, res) => {
    const cwd = String(req.query.cwd ?? '');
    const branch = String(req.query.branch ?? '');
    if (!cwd || !branch) return res.status(400).json({ error: 'cwd and branch required' });
    if (!stateManager.isKnownRoomCwd(cwd)) return res.status(404).json({ error: 'unknown cwd' });
    const full = await stateManager.getPrCache().getOrFetchFull(cwd, branch);
    res.json(full);
  });

  // Per-room PR history (last 10 observed). Populated lazily by prCache as it
  // observes PRs during background polls + user clicks; persisted to disk so
  // history survives restarts.
  app.get('/api/git/pr-history', (req, res) => {
    const cwd = String(req.query.cwd ?? '');
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    if (!stateManager.isKnownRoomCwd(cwd)) return res.status(404).json({ error: 'unknown cwd' });
    const entries = stateManager.getPrHistoryStore().list(cwd);
    res.json({ entries });
  });

  // Debug endpoint: spawn a test session
  app.post('/api/debug/spawn', express.json(), (req, res) => {
    const cwd = String(req.body?.cwd ?? process.cwd());
    const name = req.body?.name ? String(req.body.name) : undefined;
    const ptySessionId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stateManager.trackPendingPtySpawn(cwd, ptySessionId);
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
    linkageTracker.trackCloneInfo(ptySessionId, { name: cloneName, originalSessionId: sessionId });
    try {
      ptyManager.spawn(ptySessionId, session.cwd, 80, 24, ['--resume', sessionId, '--fork-session', '--name', `${cloneName}___OVR:${ptySessionId}`]);
      log('pty:started', 'PTY test clone', { sessionId: ptySessionId, sessionName: cloneName });
      res.json({ ok: true, ptySessionId, cloneName });
    } catch (err) {
      linkageTracker.dropCloneInfo(ptySessionId);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Debug endpoint: Jira title cache internals
  app.get('/api/debug/jira', (_req, res) => {
    res.json(getJiraCacheStats());
  });

  // Debug endpoint: dump current state snapshot
  app.get('/api/debug/state', (_req, res) => {
    const snapshot = stateManager.getSnapshot();
    const sessions = snapshot.rooms.flatMap(r => r.sessions);
    res.json({
      sessionCount: sessions.length,
      sessions: sessions.map(s => ({
        sessionId: s.sessionId,
        name: s.proposedName ?? '',
        cwd: s.cwd,
        state: s.state,
        isWorker: s.isWorker,
        pid: s.pid,
        sessionType: s.sessionType,
        replacedBy: s.replacedBy,
        permissionMode: s.permissionMode,
        permissionModeLockedUntil: s.permissionModeLockedUntil,
        needsPermission: s.needsPermission,
        resumedFrom: s.resumedFrom,
        lastActivity: s.lastActivity,
        overlordId: s.overlordId,
        color: s.color,
      })),
      ovrToPty: Object.fromEntries(ovrToPty),
      ptyToOvr: Object.fromEntries(ptyToOvr),
      pendingPtyByPid: Object.fromEntries([...linkageTracker.byPid].map(([pid, entry]) => [pid, entry.ptySessionId])),
      pendingPtyByResumeId: Object.fromEntries([...linkageTracker.byResumeId].map(([id, entry]) => [id, entry.ptySessionId])),
      pendingClearSessions: stateManager.getPendingClearSessions(),
      bridgeSessions: Object.keys(stateManager.deriveBridgeRegistry()),
      bridgeConnected: Object.keys(stateManager.deriveBridgeRegistry()).map(id => ({ id: id.slice(0, 8), connected: bridgeManager.isConnected(id), pipeAddr: bridgeManager.getPipeAddr(id) })),
    });
  });

  // Recovery endpoint: scrub self-referential replacedBy on every active
  // OverlordSession. Such records are hidden forever by getSnapshot's
  // replacedBy filter. The boot loadAll scrub fixes them on restart;
  // this endpoint runs the same scrub live.
  // Force-complete a stuck /clear inFlight flag. Used when claude's auto-compact
  // overlapped a /clear inject and the replacement transcript never arrived,
  // freezing the activity feed. POST /api/debug/unstick-clear/:sessionId
  app.post('/api/debug/unstick-clear/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const cleared = stateManager.forceCompleteClear(sessionId);
    res.json({ sessionId, cleared });
  });

  app.post('/api/debug/heal-replaced-by', (_req, res) => {
    const result = scrubReplacedBy();
    res.json({ ...result, count: result.selfRef.length + result.orphanSuccessor.length });
  });

  // Debug endpoint: dump raw PTY buffer tail for a session (hex + stripped),
  // used to diagnose status-bar mode detection failures.
  app.get('/api/debug/pty-buffer/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = stateManager.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    const ovrId = session.overlordId ?? sessionId;
    const bufKey = stateManager.isBridge(sessionId) ? ovrId : (ovrToPty.get(ovrId) ?? null);
    if (!bufKey) { res.status(404).json({ error: 'no pty buffer key' }); return; }
    const chunks = ptyOutputBuffer.get(bufKey);
    if (!chunks || chunks.length === 0) { res.json({ text: '', stripped: '', hex: '' }); return; }
    const raw = Buffer.concat(chunks.slice(-20)).toString('utf8');
    const stripped = raw
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
      .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
      .replace(/\x1b[^[\]]/g, '')
      .replace(/\x1b/g, '')
      .replace(/[^\x20-\x7e\n\t\r]/g, (ch) => /\s/.test(ch) ? ' ' : '');
    // Locate last shift+tab sentinel and show 200 chars before it (both utf8 and hex)
    const re = /\(shift\+tab to cycle\)/gi;
    let lastIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) lastIdx = m.index;
    const prefix = lastIdx >= 0 ? stripped.slice(Math.max(0, lastIdx - 200), lastIdx) : '';
    const rawPrefix = lastIdx >= 0 ? raw.slice(Math.max(0, raw.lastIndexOf('(shift+tab to cycle)') - 200), raw.lastIndexOf('(shift+tab to cycle)')) : '';
    const hex = Buffer.from(rawPrefix, 'utf8').toString('hex');
    res.json({
      strippedTail: stripped.slice(-400),
      sentinelFound: lastIdx >= 0,
      prefixBeforeSentinel: prefix,
      rawPrefixHex: hex,
      bufKey,
      permissionMode: session.permissionMode,
      locked: session.permissionModeLockedUntil,
    });
  });

  // Debug endpoint: PTY buffer stats (chunk count, total bytes, BSU marker positions).
  // Diagnoses replay bloat: if chunks accumulate far past the last BSU, replay
  // sends a large blob and feels slow on reconnect.
  app.get('/api/debug/pty-stats/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = stateManager.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    const ovrId = session.overlordId ?? sessionId;
    const bufKey = stateManager.isBridge(sessionId) ? ovrId : (ovrToPty.get(ovrId) ?? ovrId);
    const chunks = ptyOutputBuffer.get(bufKey);
    if (!chunks) { res.json({ bufKey, chunkCount: 0, totalBytes: 0, bsuCount: 0 }); return; }
    const bsuMarker = Buffer.from('\x1b[?2026h');
    const besuMarker = Buffer.from('\x1b[?2026l');
    let totalBytes = 0;
    let bsuCount = 0;
    let besuCount = 0;
    const chunkSizes: number[] = [];
    let lastBsuChunk = -1;
    let lastBsuByteOffset = -1;
    chunks.forEach((c, i) => {
      totalBytes += c.length;
      chunkSizes.push(c.length);
      if (c.indexOf(bsuMarker) >= 0) { bsuCount++; lastBsuChunk = i; lastBsuByteOffset = totalBytes; }
      if (c.indexOf(besuMarker) >= 0) besuCount++;
    });
    res.json({
      bufKey,
      sessionType: session.sessionType,
      state: session.state,
      chunkCount: chunks.length,
      totalBytes,
      bsuCount,
      besuCount,
      lastBsuChunkIndex: lastBsuChunk,
      chunksSinceLastBsu: lastBsuChunk >= 0 ? chunks.length - 1 - lastBsuChunk : chunks.length,
      bytesSinceLastBsu: lastBsuByteOffset >= 0 ? totalBytes - lastBsuByteOffset : totalBytes,
      minChunkSize: Math.min(...chunkSizes),
      maxChunkSize: Math.max(...chunkSizes),
      avgChunkSize: Math.round(totalBytes / chunks.length),
    });
  });

  // Debug endpoint: show stable ovrId → claudeId → ptyId identity mappings
  app.get('/api/debug/identity', (_req, res) => {
    const snapshot = stateManager.getSnapshot();
    const sessions = snapshot.rooms.flatMap(r => r.sessions);
    const identities = sessions.map(s => ({
      claudeId: s.sessionId.slice(0, 8),
      ovrId: (s as { overlordId?: string }).overlordId ?? '(none)',
      ptyId: (() => { const oId = (s as { overlordId?: string }).overlordId; return oId ? (ovrToPty.get(oId)?.slice(0, 12) ?? '(none)') : '(none)'; })(),
      name: s.proposedName ?? '',
      state: s.state,
      sessionType: s.sessionType ?? '',
    }));
    res.json({ identities, ovrToPty: Object.fromEntries([...ovrToPty].map(([k, v]) => [k, v.slice(0, 12)])), ptyToOvr: Object.fromEntries([...ptyToOvr].map(([k, v]) => [k.slice(0, 12), v])) });
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
        // Suppress the WAITING→WORKING promotion for the brief window during which the TUI
        // redraws its status bar in response to our injected shift+tab. Otherwise the chip
        // visibly flickers to WORKING on every click.
        stateManager.suppressPtyPromotion(sessionId, 1200);

        // Inject Shift+Tab to cycle the mode.
        // Prefer ptyManager.write for Overlord-spawned PTYs (CGEvent can't reach node-pty).
        const ovrIdForPty = session.overlordId ?? sessionId;
        const ptyIdForWrite = ovrToPty.get(ovrIdForPty);
        const ptyWrote = ptyIdForWrite ? ptyManager.write(ptyIdForWrite, '\x1b[Z') : false;
        console.log(`[cycle-perm] sid=${sessionId} ovr=${ovrIdForPty} ptyId=${ptyIdForWrite ?? '(none)'} ptyWrote=${ptyWrote} isBridge=${stateManager.isBridge(sessionId)} pid=${session.pid}`);
        if (!ptyWrote) {
          if (stateManager.isBridge(sessionId)) {
            await injectViaPipe(sessionId, '\x1b[Z');
          } else if (process.platform === 'darwin') {
            await injectViaMac(session.pid, '\x1b[Z', false);
          } else {
            await injectText(session.pid, '\x1b[Z', false, true);
          }
        }

        // Wait for the TUI to update, then read screen.
        // 500ms kept for correctness on the Windows readScreen path — sampling too early
        // returns the pre-click mode and setPermissionMode would overwrite the value the
        // async paths already wrote. Perceived click latency is unaffected because
        // ptyEvents / bridge buffer broadcast the new mode within ~50ms independently.
        await new Promise(r => setTimeout(r, 500));
        let text: string | null = null;
        const sess2 = stateManager.getSession(sessionId);
        const ovrId2 = sess2?.overlordId ?? sessionId;
        const bufKey = stateManager.isBridge(sessionId) ? ovrId2 : (ovrToPty.get(ovrId2) ?? null);
        if (bufKey) {
          const chunks = ptyOutputBuffer.get(bufKey);
          if (chunks && chunks.length > 0) {
            const raw = Buffer.concat(chunks.slice(-50)).toString('utf8');
            const stripped = raw
              .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
              .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
              .replace(/\x1b[^[\]]/g, '')
              .replace(/\x1b/g, '')
              .replace(/[^\x20-\x7e\n\t\r]/g, (ch) => /\s/.test(ch) ? ' ' : '');
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

        // Detect new mode from screen text (supports unknown/custom modes via status-bar sentinel).
        let newMode: string | undefined;
        if (text) {
          const { sentinelFound, mode } = detectModeFromText(text);
          if (sentinelFound && mode) newMode = mode;
        }

        // Fallback: if the screen read missed the sentinel (Claude was mid-compute and
        // the status bar isn't rendered), predict the next mode from the known Claude CLI
        // cycle order so the chip reflects the click immediately. The next PTY-detected
        // status bar will correct any drift.
        if (newMode === undefined) {
          const current = stateManager.getSession(sessionId)?.permissionMode;
          newMode =
            current === 'default' ? 'acceptEdits' :
            current === 'acceptEdits' ? 'plan' :
            current === 'plan' ? 'default' :
            current === 'bypassPermissions' ? 'acceptEdits' :
            'default';
        }

        stateManager.setPermissionMode(sessionId, newMode);

        res.json({ ok: true, mode: stateManager.getSession(sessionId)?.permissionMode });
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

  // Delete a session from state (removes from UI; kills the process for bridge sessions)
  app.delete('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = stateManager.getSession(sessionId);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    const pidToKill = session.sessionType === 'bridge' ? session.pid : undefined;
    deleteSession(sessionId, pidToKill, 'session:delete (REST)');
    res.json({ ok: true });
  });

  // Manually mark a session as done
  app.post('/api/sessions/:sessionId/mark-done', (req, res) => {
    const { sessionId } = req.params;
    const ok = stateManager.markDoneByUser(sessionId);
    if (!ok) { res.status(404).json({ error: 'session not found or idle' }); return; }
    res.json({ ok: true });
  });

  // Toggle acknowledged — silences WAITING bubble without marking done
  app.post('/api/sessions/:sessionId/ack', (req, res) => {
    const { sessionId } = req.params;
    const next = stateManager.toggleAckByUser(sessionId);
    if (next === null) { res.status(404).json({ error: 'session not found or closed' }); return; }
    res.json({ acknowledged: next });
  });

  // Dismiss a Jira ticket chip — drops the key from the session and remembers
  // it under jiraKeysDismissed so the next transcript scan won't re-add it.
  app.delete('/api/sessions/:sessionId/jira-keys/:key', (req, res) => {
    const { sessionId, key } = req.params;
    // Validate against the configured project allowlist regex — prevents
    // arbitrary strings being written to disk via this endpoint.
    const raw = globalSettingsStore.get().jiraProjects;
    if (!raw) { res.status(400).json({ error: 'JIRA project allowlist not configured' }); return; }
    const tokens = raw.split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z][A-Z0-9]{1,9}$/.test(s));
    if (tokens.length === 0) { res.status(400).json({ error: 'JIRA project allowlist not configured' }); return; }
    const re = new RegExp(String.raw`^(${tokens.join('|')})-(\d{1,6})$`);
    if (!re.test(key)) { res.status(400).json({ error: 'Invalid JIRA key' }); return; }
    const ok = stateManager.dismissJiraKey(sessionId, key);
    if (!ok) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({ ok: true });
  });

  // Accept a done session (user reviewed and confirmed result)
  app.post('/api/sessions/:sessionId/accept', (req, res) => {
    const { sessionId } = req.params;
    const ok = stateManager.acceptSession(sessionId);
    if (!ok) { res.status(404).json({ error: 'session not found' }); return; }
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
        .replace(/[^\x20-\x7e\n\t\r]/g, (ch) => /\s/.test(ch) ? ' ' : '');
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

  // Room config for a room (scoped by cwd). Stores per-room settings like the session prefix.
  app.get('/api/room-config', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd) { res.status(400).json({ error: 'cwd required' }); return; }
    if (!stateManager.isKnownRoomCwd(cwd)) { res.status(404).json({ error: 'unknown cwd' }); return; }
    res.json(readRoomConfig(cwd));
  });

  app.post('/api/room-config', express.json(), (req, res) => {
    const { cwd, prefix, description, lastMode, lastProvider } = (req.body ?? {}) as { cwd?: string; prefix?: string; description?: string; lastMode?: string; lastProvider?: string };
    if (!cwd || typeof cwd !== 'string') { res.status(400).json({ error: 'cwd required' }); return; }
    if (prefix !== undefined && typeof prefix !== 'string') { res.status(400).json({ error: 'prefix must be a string' }); return; }
    if (description !== undefined && typeof description !== 'string') { res.status(400).json({ error: 'description must be a string' }); return; }
    const validModes = ['embedded', 'bridge', 'plain', 'raw'] as const;
    const validProviders = ['claude', 'opencode'] as const;
    if (lastMode !== undefined && !validModes.includes(lastMode as typeof validModes[number])) {
      res.status(400).json({ error: 'lastMode must be embedded|bridge|plain|raw' });
      return;
    }
    if (lastProvider !== undefined && !validProviders.includes(lastProvider as typeof validProviders[number])) {
      res.status(400).json({ error: 'lastProvider must be claude|opencode' });
      return;
    }
    if (!stateManager.isKnownRoomCwd(cwd)) { res.status(404).json({ error: 'unknown cwd' }); return; }
    const current = readRoomConfig(cwd);
    writeRoomConfig(cwd, {
      prefix: prefix !== undefined ? prefix : current.prefix,
      description: description !== undefined ? description : current.description,
      lastMode: lastMode !== undefined ? (lastMode as typeof validModes[number]) : current.lastMode,
      lastProvider: lastProvider !== undefined ? (lastProvider as typeof validProviders[number]) : current.lastProvider,
    });
    res.json({ ok: true });
  });

  // Brain context for a room (scoped by cwd). All brain fields are cwd-derived, so the
  // endpoint lives at the room level. Only known-room cwds are allowed to prevent probing.
  app.get('/api/brain', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd) { res.status(400).json({ error: 'cwd required' }); return; }
    if (!stateManager.isKnownRoomCwd(cwd)) { res.status(404).json({ error: 'unknown cwd' }); return; }
    try {
      const context = getBrainContext(cwd);
      res.json(context);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Brain: read a single file referenced by the context (CLAUDE.md, memory file, etc.).
  // Only allows files inside ~/.claude/ or under a known room's cwd — no arbitrary reads.
  app.get('/api/brain/file', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!cwd) { res.status(400).json({ error: 'cwd required' }); return; }
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    if (!stateManager.isKnownRoomCwd(cwd)) { res.status(404).json({ error: 'unknown cwd' }); return; }
    const resolved = resolve(filePath);
    const homeDir = resolve(os.homedir(), '.claude');
    const cwdResolved = resolve(cwd);
    const allowed = resolved.startsWith(homeDir + '/') || resolved === homeDir
      || resolved.startsWith(cwdResolved + '/') || resolved === cwdResolved;
    if (!allowed) { res.status(403).json({ error: 'path outside allowed scope' }); return; }
    try {
      if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'file not found' }); return; }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) { res.status(400).json({ error: 'not a file' }); return; }
      const raw = fs.readFileSync(resolved, 'utf-8');
      const lines = raw.split('\n');
      const LINE_CAP = 500;
      const truncated = lines.length > LINE_CAP;
      const content = truncated ? lines.slice(0, LINE_CAP).join('\n') : raw;
      res.json({ path: resolved, content, totalLines: lines.length, truncated });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Brain: write a single editable file (CLAUDE.md or memory/*.md) back to disk.
  // Scope mirrors GET /api/brain/file, then narrows further to editable file types.
  app.put('/api/brain/file', express.json({ limit: '1mb' }), (req, res) => {
    const { cwd, path: filePath, content } = (req.body ?? {}) as { cwd?: string; path?: string; content?: string };
    if (!cwd || typeof cwd !== 'string') { res.status(400).json({ error: 'cwd required' }); return; }
    if (!filePath || typeof filePath !== 'string') { res.status(400).json({ error: 'path required' }); return; }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return; }
    if (!stateManager.isKnownRoomCwd(cwd)) { res.status(404).json({ error: 'unknown cwd' }); return; }
    const resolved = resolve(filePath);
    const homeDir = resolve(os.homedir(), '.claude');
    const cwdResolved = resolve(cwd);
    const inScope = resolved.startsWith(homeDir + '/') || resolved === homeDir
      || resolved.startsWith(cwdResolved + '/') || resolved === cwdResolved;
    if (!inScope) { res.status(403).json({ error: 'path outside allowed scope' }); return; }
    const isClaudeMd = basename(resolved) === 'CLAUDE.md';
    const memoryRoot = resolve(os.homedir(), '.claude', 'projects');
    const isMemoryFile = resolved.startsWith(memoryRoot + '/')
      && resolved.endsWith('.md')
      && resolved.split('/').includes('memory');
    if (!isClaudeMd && !isMemoryFile) {
      res.status(403).json({ error: 'path type not editable' });
      return;
    }
    try {
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) { res.status(400).json({ error: 'not a file' }); return; }
      }
      fs.writeFileSync(resolved, content, 'utf-8');
      invalidateBrainCache(cwd);
      const totalLines = content.length === 0 ? 0 : content.split('\n').length;
      res.json({ ok: true, path: resolved, totalLines });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Inline file editor endpoints
  app.get('/api/file', (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'not found' }); return; }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      let writable = false;
      try { fs.accessSync(filePath, fs.constants.W_OK); writable = true; } catch { /* read-only */ }
      res.json({ content, writable });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/file', express.json({ limit: '10mb' }), (req, res) => {
    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!filePath || typeof content !== 'string') { res.status(400).json({ error: 'path and content required' }); return; }
    try { fs.accessSync(filePath, fs.constants.W_OK); } catch { res.status(403).json({ error: 'not writable' }); return; }
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      res.status(204).send();
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

  // Return skills and agents from .claude/skills and .claude/agents in a workspace cwd
  app.get('/api/skills-agents', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd) { res.status(400).json({ error: 'cwd query param required' }); return; }

    function extractDescription(raw: string): string {
      // Try YAML frontmatter description field first
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (descMatch) return descMatch[1].trim();
      }
      // Fall back to first non-empty non-frontmatter/non-heading paragraph line
      const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '');
      const lines = body.split('\n');
      // Skip h1 headings, return first content line
      const h1 = lines.find(l => /^#\s/.test(l));
      if (h1) {
        const after = lines.slice(lines.indexOf(h1) + 1);
        const first = after.find(l => l.trim().length > 0 && !/^#/.test(l));
        if (first) return first.replace(/^\*\*/, '').replace(/\*\*$/, '').trim().slice(0, 120);
      }
      const first = lines.find(l => l.trim().length > 0 && !/^#/.test(l));
      return (first ?? '').trim().slice(0, 120);
    }

    function parseMdFile(filePath: string, name: string): { name: string; description: string; content: string } {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { name, description: extractDescription(raw), content: raw };
      } catch { return { name, description: '', content: '' }; }
    }

    function readDir(dir: string): { name: string; description: string }[] {
      if (!fs.existsSync(dir)) return [];
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const results: { name: string; description: string }[] = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isDirectory()) {
            // Skill/agent as a directory — look for SKILL.md, AGENT.md, or README.md
            const candidates = ['SKILL.md', 'AGENT.md', 'README.md'];
            for (const candidate of candidates) {
              const mdPath = join(dir, entry.name, candidate);
              if (fs.existsSync(mdPath)) {
                results.push(parseMdFile(mdPath, entry.name));
                break;
              }
            }
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push(parseMdFile(join(dir, entry.name), basename(entry.name, '.md')));
          }
        }
        return results;
      } catch { return []; }
    }

    const skills = readDir(join(cwd, '.claude', 'skills'));
    const agents = readDir(join(cwd, '.claude', 'agents'));
    res.json({ skills, agents });
  });

  // Color: PUT /api/sessions/:sessionId/color — set avatar color for a session (persisted by ovrId)
  app.put('/api/sessions/:sessionId/color', express.json(), (req, res) => {
    const { sessionId } = req.params;
    const color = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
    if (!color) { res.status(400).json({ error: 'color required' }); return; }
    const ok = stateManager.setSessionColor(sessionId, color);
    if (!ok) { res.status(404).json({ error: 'session not found' }); return; }
    res.json({ ok: true });
  });

  app.put('/api/sessions/:sessionId/name', express.json(), (req, res) => {
    const { sessionId } = req.params;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const ok = stateManager.setSessionName(sessionId, name);
    if (!ok) { res.status(404).json({ error: 'session not found' }); return; }
    res.json({ ok: true });
  });

  // Notes: GET /api/notes — all notes (for bulk display in worker cards).
  // Keyed by the overlord's current sessionId so the client can look up by its
  // live session handle without knowing the overlordId.
  app.get('/api/notes', (_req, res) => {
    const out: Record<string, string> = {};
    for (const rec of sessionStore.listActive()) {
      if (typeof rec.notes === 'string' && rec.notes.length > 0) {
        out[rec.lineage.currentSessionId] = rec.notes;
      }
    }
    res.json(out);
  });

  // Notes: GET /api/sessions/:sessionId/notes
  app.get('/api/sessions/:sessionId/notes', (req, res) => {
    const { sessionId } = req.params;
    res.json({ notes: sessionStore.getBySessionId(sessionId)?.notes ?? '' });
  });

  // Notes: PUT /api/sessions/:sessionId/notes
  app.put('/api/sessions/:sessionId/notes', express.json(), (req, res) => {
    const { sessionId } = req.params;
    const content = typeof req.body?.notes === 'string' ? req.body.notes : '';
    let rec = sessionStore.getBySessionId(sessionId);
    if (!rec) {
      const live = stateManager.getSession(sessionId);
      if (live) rec = sessionStore.ensureFromLive(live);
    }
    if (rec) sessionStore.patch(rec.overlordId, { notes: content === '' ? undefined : content });
    res.json({ ok: true });
  });

  // Archive: list entries for a room
  app.get('/api/archive/by-room/:roomId', (req, res) => {
    const { roomId } = req.params;
    res.json({ entries: archiveManager.listByRoom(roomId) });
  });

  // Archive: full list
  app.get('/api/archive', (_req, res) => {
    res.json({ entries: archiveManager.list() });
  });

  // Archive: on-demand stats for an archived session (start/finish/duration/counts)
  app.get('/api/archive/:sessionId/stats', (req, res) => {
    const { sessionId } = req.params;
    const entry = archiveManager.get(sessionId);
    if (!entry) { res.status(404).json({ error: 'archive entry not found' }); return; }
    try {
      const stats = computeArchiveStats(entry);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Archive: read transcript activity feed for an archived session
  app.get('/api/archive/:sessionId/transcript', (req, res) => {
    const { sessionId } = req.params;
    const entry = archiveManager.get(sessionId);
    if (!entry) { res.status(404).json({ error: 'archive entry not found' }); return; }
    try {
      if (!fs.existsSync(entry.transcriptPath)) {
        res.status(404).json({ error: 'archived transcript missing' });
        return;
      }
      const state = readTranscriptState(entry.transcriptPath);
      res.json({
        sessionId,
        name: entry.name,
        archivedAt: entry.archivedAt,
        cwd: entry.cwd,
        activityFeed: state.activityFeed ?? [],
        lastMessage: state.lastMessage,
        lastActivity: state.lastActivity,
        model: state.model,
        intent: entry.intent,
        notes: entry.notes,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Archive: free-text search across all archived transcripts.
  // Mirrors the client-side search logic in packages/client/src/lib/search.tsx.
  app.get('/api/archive/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? '300'), 10) || 300));
    if (q.length < 2) { res.json({ entries: [], truncated: false }); return; }
    const qLower = q.toLowerCase();

    function buildCorpus(item: { kind?: string; isRedacted?: boolean; content?: string; inputJson?: string }): string {
      if (item.kind === 'thinking' && item.isRedacted) return '';
      const parts: string[] = [item.content ?? ''];
      if (item.inputJson) parts.push(item.inputJson);
      return parts.join(' ');
    }

    function makeExcerpt(corpus: string, windowSize = 120): { text: string; start: number; end: number } {
      const lower = corpus.toLowerCase();
      const idx = lower.indexOf(qLower);
      if (idx === -1) return { text: corpus.slice(0, windowSize), start: -1, end: -1 };
      const half = Math.floor(windowSize / 2);
      const from = Math.max(0, idx - half + Math.floor(q.length / 2));
      const to = Math.min(corpus.length, from + windowSize);
      const adjusted = Math.max(0, to - windowSize);
      const text = (adjusted > 0 ? '…' : '') + corpus.slice(adjusted, to) + (to < corpus.length ? '…' : '');
      const matchInExcerpt = idx - adjusted + (adjusted > 0 ? 1 : 0);
      return { text, start: matchInExcerpt, end: matchInExcerpt + q.length };
    }

    const TRUNC = 400;
    const entries: Array<{ entry: unknown; matches: unknown[] }> = [];
    let total = 0;
    let truncated = false;

    for (const entry of archiveManager.list()) {
      if (total >= limit) { truncated = true; break; }
      const matches: unknown[] = [];

      // Synthetic JIRA items from the persisted record's jiraKeys (with title
      // when the server-side cache has it). Matches each "KEY — Title" line.
      const jiraKeys = sessionStore.getByOverlordId(entry.overlordId)?.jiraKeys ?? [];
      for (const key of jiraKeys) {
        if (total + matches.length >= limit) { truncated = true; break; }
        const title = getCachedJiraTitle(key);
        const content = title ? `${key} — ${title}` : key;
        if (!content.toLowerCase().includes(qLower)) continue;
        const { text, start, end } = makeExcerpt(content);
        matches.push({
          item: { kind: 'tool', toolName: 'JIRA', content: content.slice(0, TRUNC) },
          excerpt: text,
          boldRanges: start >= 0 ? [[start, end]] : [],
        });
      }

      if (fs.existsSync(entry.transcriptPath)) {
        let feed: NonNullable<ReturnType<typeof readTranscriptState>['activityFeed']> = [];
        try {
          feed = readTranscriptState(entry.transcriptPath).activityFeed ?? [];
        } catch { feed = []; }
        for (const item of feed) {
          if (total + matches.length >= limit) { truncated = true; break; }
          const corpus = buildCorpus(item);
          if (!corpus.toLowerCase().includes(qLower)) continue;
          const { text, start, end } = makeExcerpt(corpus);
          matches.push({
            item: {
              kind: item.kind,
              role: item.role,
              toolName: item.toolName,
              timestamp: item.timestamp,
              content: (item.content ?? '').slice(0, TRUNC),
              inputJson: item.inputJson ? item.inputJson.slice(0, TRUNC) : undefined,
              isRedacted: item.isRedacted,
            },
            excerpt: text,
            boldRanges: start >= 0 ? [[start, end]] : [],
          });
        }
      }
      if (matches.length > 0) {
        entries.push({ entry, matches });
        total += matches.length;
      }
    }

    res.json({ entries, truncated });
  });

  // Archive: archive a live session
  app.post('/api/archive/:sessionId', (req, res) => {
    void (async () => {
      const { sessionId } = req.params;
      const session = stateManager.getSession(sessionId);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }
      if (archiveManager.isArchived(sessionId)) {
        res.json({ ok: true, entry: archiveManager.get(sessionId), alreadyArchived: true });
        return;
      }
      // Resolve transcript: own sessionId first, then walk --resume parent chain.
      // Sessions spawned via `--resume` often share the parent's transcript and never
      // write one under their own sessionId, so the direct lookup misses them.
      let sourceTranscript: string | null = findTranscriptPath(session.cwd, sessionId) ?? findTranscriptPathAnywhere(sessionId);
      if (!sourceTranscript) {
        const visited = new Set<string>([sessionId]);
        let cursor: string | undefined = session.resumedFrom;
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor);
          const candidate = findTranscriptPath(session.cwd, cursor) ?? findTranscriptPathAnywhere(cursor);
          if (candidate) { sourceTranscript = candidate; break; }
          cursor = stateManager.getSession(cursor)?.resumedFrom;
        }
      }

      // Capture fields that depend on live state BEFORE we remove the session.
      // `session` is a live object; remove() only drops it from the Map, so its
      // fields stay readable through the captured reference.
      const capturedCwd = session.cwd;
      const capturedName = session.proposedName ?? sessionId.slice(0, 8);
      const capturedPid = session.pid;
      const capturedProvider = session.provider;
      const capturedSessionType = session.sessionType;
      const capturedStartedAt = session.startedAt;
      const capturedColor = stateManager.sessionColor(sessionId);
      const capturedLastMessage = session.lastMessage;
      const capturedLastActivity = session.lastActivity;
      const capturedModel = session.model;
      const pidToKill = capturedSessionType === 'bridge' ? capturedPid : undefined;

      // FAST PATH: yank session from state IMMEDIATELY, before any git/transcript I/O.
      // The setImmediate yield flushes the snapshot broadcast so the worker disappears
      // from the room within a frame, instead of waiting on `git` + transcript reads.
      stateManager.remove(sessionId);
      await new Promise<void>(resolve => setImmediate(resolve));

      // Respond NOW. Heavy work (git subprocess, transcript read, transcript copy,
      // process kill, file cleanup) runs in the background — the room is already
      // empty in the broadcast snapshot, and `archive:added` populates the archive
      // list when the work finishes.
      res.json({ ok: true, pending: true, sessionId });

      // Run git status + transcript read in parallel — they're independent.
      const [gitResult, transcriptResult] = await Promise.all([
        (async () => {
          try {
            const git = await readGitStatus(capturedCwd, stateManager.getPrCache());
            const cachedPr = stateManager.getPrCache().get(capturedCwd, git?.branch ?? undefined);
            return { branch: git?.branch, pr: cachedPr };
          } catch { return { branch: undefined, pr: undefined }; }
        })(),
        (async () => {
          if (!sourceTranscript || !fs.existsSync(sourceTranscript)) return undefined;
          try { return readTranscriptState(sourceTranscript); } catch { return undefined; }
        })(),
      ]);

      const archiveParams = {
        sessionId,
        cwd: capturedCwd,
        name: capturedName,
        pid: capturedPid,
        sourceTranscriptPath: sourceTranscript,
        provider: capturedProvider,
        sessionType: capturedSessionType,
        startedAt: capturedStartedAt,
        color: capturedColor,
        gitBranch: gitResult.branch ?? undefined,
        pullRequest: gitResult.pr ?? undefined,
        lastMessage: transcriptResult?.lastMessage ?? capturedLastMessage,
        lastActivity: transcriptResult?.lastActivity ?? capturedLastActivity,
        model: transcriptResult?.model ?? capturedModel,
      };

      // Heavy work: transcript copy + process kill + file cleanup
      const entry = archiveManager.archive(archiveParams);
      if (!entry) {
        deleteSession(sessionId, pidToKill, 'archive-failed');
        log('session:killed', 'Session archive failed (transcript missing)', { sessionId });
        return;
      }
      deleteSession(sessionId, pidToKill, 'archive');
      if (broadcastRaw) {
        broadcastRaw({ type: 'archive:added', entry });
      }
      log('session:killed', 'Session archived', { sessionId, sessionName: entry.name });
    })();
  });

  // Archive: unarchive — restore transcript into ~/.claude/projects and drop the entry
  app.post('/api/archive/:sessionId/unarchive', (req, res) => {
    const { sessionId } = req.params;
    const entry = archiveManager.get(sessionId);
    if (!entry) { res.status(404).json({ error: 'archive entry not found' }); return; }
    const restored = archiveManager.restoreTranscript(sessionId);
    if (!restored) {
      res.status(500).json({ error: 'failed to restore transcript' });
      return;
    }
    archiveManager.remove(sessionId);
    stateManager.rehydrateFromSessionStore(sessionId);
    if (broadcastRaw) broadcastRaw({ type: 'archive:removed', sessionId, roomId: entry.roomId });
    log('info', 'Session unarchived', { sessionId, sessionName: entry.name });
    res.json({ ok: true, sessionId, cwd: entry.cwd, name: entry.name });
  });

  // Archive: delete — permanently remove an archived session (transcripts +
  // record). Does NOT restore the transcript. No going back.
  app.delete('/api/archive/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const entry = archiveManager.get(sessionId);
    if (!entry) { res.status(404).json({ error: 'archive entry not found' }); return; }
    const ok = archiveManager.deleteArchive(sessionId);
    if (!ok) { res.status(500).json({ error: 'failed to delete archive' }); return; }
    if (broadcastRaw) broadcastRaw({ type: 'archive:removed', sessionId, roomId: entry.roomId });
    log('session:killed', 'Archived session deleted', { sessionId, sessionName: entry.name });
    res.json({ ok: true, sessionId, roomId: entry.roomId });
  });

  // Archive: clone-prepare — restore transcript into ~/.claude/projects but keep archive entry
  app.post('/api/archive/:sessionId/clone-prepare', (req, res) => {
    const { sessionId } = req.params;
    const entry = archiveManager.get(sessionId);
    if (!entry) { res.status(404).json({ error: 'archive entry not found' }); return; }
    const restored = archiveManager.restoreTranscript(sessionId);
    if (!restored) {
      res.status(500).json({ error: 'failed to restore transcript' });
      return;
    }
    res.json({ ok: true, sessionId, cwd: entry.cwd, name: entry.name });
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
      const result = readActivityBefore(transcriptPath, timestamp, Number(limit) || 100);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Resolve session by PID ───────────────────────────────────────────────

  app.get('/api/resolve', (req, res) => {
    const pidRaw = req.query.pid;
    if (typeof pidRaw !== 'string' || !/^\d+$/.test(pidRaw)) {
      res.status(400).json({ error: 'pid query param required (numeric)' });
      return;
    }
    const pid = parseInt(pidRaw, 10);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    const sessionFilePath = join(home, '.claude', 'sessions', `${pid}.json`);
    let sessionId: string | undefined;
    try {
      const raw = fs.readFileSync(sessionFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
    } catch {
      res.status(404).json({ error: `no session file for pid ${pid}` });
      return;
    }
    if (!sessionId) {
      res.status(404).json({ error: `session file for pid ${pid} has no sessionId` });
      return;
    }
    const session = stateManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: `sessionId ${sessionId} not tracked by overlord` });
      return;
    }
    res.json({ overlordId: session.overlordId, sessionId, cwd: session.cwd });
  });

  // ── Artifacts ────────────────────────────────────────────────────────────

  const VALID_ARTIFACT_STATUSES: ArtifactStatus[] = ['draft', 'active', 'done', 'archived'];
  const VALID_ARTIFACT_KINDS: ArtifactKind[] = ['plan', 'summary', 'compact'];

  const emitArtifactChanged = (event: ArtifactChangedEvent): void => {
    if (broadcastRaw) {
      broadcastRaw(event);
      broadcastRaw({ type: 'snapshot', ...stateManager.getSnapshot() });
    }
  };

  const parseKind = (raw: unknown): ArtifactKind | undefined => {
    if (typeof raw !== 'string') return undefined;
    return VALID_ARTIFACT_KINDS.includes(raw as ArtifactKind) ? (raw as ArtifactKind) : undefined;
  };

  app.get('/api/artifacts', (req, res) => {
    const overlordId = typeof req.query.overlordId === 'string' ? req.query.overlordId : undefined;
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (kindRaw && !VALID_ARTIFACT_KINDS.includes(kindRaw as ArtifactKind)) {
      res.status(400).json({ error: 'invalid kind' });
      return;
    }
    const kind = kindRaw as ArtifactKind | undefined;
    let artifacts: Artifact[];
    if (overlordId) artifacts = artifactStore.listByOverlord(overlordId, kind);
    else if (cwd) artifacts = artifactStore.listByCwd(cwd, kind);
    else artifacts = artifactStore.list(kind);
    res.json({ artifacts });
  });

  app.get('/api/artifacts/:artifactId', (req, res) => {
    const artifact = artifactStore.get(req.params.artifactId);
    if (!artifact) { res.status(404).json({ error: 'artifact not found' }); return; }
    res.json({ artifact });
  });

  app.post('/api/artifacts', express.json({ limit: '2mb' }), (req, res) => {
    const body = req.body as { overlordId?: unknown; title?: unknown; body?: unknown; kind?: unknown };
    const overlordId = typeof body.overlordId === 'string' ? body.overlordId : '';
    if (!overlordId) { res.status(400).json({ error: 'overlordId required' }); return; }
    const session = sessionStore.getByOverlordId(overlordId);
    if (!session) { res.status(404).json({ error: 'overlord not found' }); return; }
    const kind = parseKind(body.kind) ?? 'plan';
    const defaultTitle = kind === 'plan' ? 'Plan' : kind === 'summary' ? 'Summary' : 'Compact';
    const title = typeof body.title === 'string' && body.title.trim() ? body.title : defaultTitle;
    const artifactBody = typeof body.body === 'string' ? body.body : '';
    const artifact = artifactStore.create({
      kind,
      overlordId,
      cwd: session.cwd,
      title,
      body: artifactBody,
      source: 'user',
    });
    emitArtifactChanged({ type: 'artifact:changed', artifactId: artifact.artifactId, kind: artifact.kind, overlordId: artifact.overlordId, cwd: artifact.cwd, op: 'create' });
    res.json({ artifact });
  });

  app.put('/api/artifacts/:artifactId', express.json({ limit: '2mb' }), (req, res) => {
    const body = req.body as { title?: unknown; body?: unknown; status?: unknown };
    const patch: { title?: string; body?: string; status?: ArtifactStatus } = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.body === 'string') patch.body = body.body;
    if (typeof body.status === 'string') {
      if (!VALID_ARTIFACT_STATUSES.includes(body.status as ArtifactStatus)) {
        res.status(400).json({ error: 'invalid status' }); return;
      }
      patch.status = body.status as ArtifactStatus;
    }
    const artifact = artifactStore.patch(req.params.artifactId, patch);
    if (!artifact) { res.status(404).json({ error: 'artifact not found' }); return; }
    emitArtifactChanged({ type: 'artifact:changed', artifactId: artifact.artifactId, kind: artifact.kind, overlordId: artifact.overlordId, cwd: artifact.cwd, op: 'update' });
    res.json({ artifact });
  });

  app.delete('/api/artifacts/:artifactId', (req, res) => {
    const existing = artifactStore.get(req.params.artifactId);
    if (!existing) { res.status(404).json({ error: 'artifact not found' }); return; }
    artifactStore.remove(req.params.artifactId);
    emitArtifactChanged({ type: 'artifact:changed', artifactId: existing.artifactId, kind: existing.kind, overlordId: existing.overlordId, cwd: existing.cwd, op: 'delete' });
    res.json({ ok: true });
  });
}
