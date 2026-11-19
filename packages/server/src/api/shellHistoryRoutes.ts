import express, { type Express } from 'express';
import type { StateManager } from '../session/stateManager.js';
import { countLines, readAll, trimChunks, trimLog } from '../pty/shellHistoryLog.js';

export const DEFAULT_KEEP_LINES = 500;

export interface ShellHistoryDeps {
  stateManager: Pick<StateManager, 'getSession' | 'getActiveClaudeByOvr'>;
  ovrToPty: Map<string, string>;
  ptyOutputBuffer: Map<string, Buffer[]>;
}

type Resolved = { ovrId: string; chunks: Buffer[] | undefined } | { error: string; status: number };

function resolveRaw(deps: ShellHistoryDeps, id: string): Resolved {
  const session = deps.stateManager.getSession(id) ?? deps.stateManager.getActiveClaudeByOvr(id);
  if (!session) return { status: 404, error: 'session not found' };
  if (session.sessionType !== 'raw') return { status: 400, error: 'not a shell session' };
  const ovrId = session.overlordId ?? id;
  // Replay buffer: keyed by ptyId while alive, by ovrId after exit.
  const ptyId = deps.ovrToPty.get(ovrId);
  const chunks = (ptyId ? deps.ptyOutputBuffer.get(ptyId) : undefined) ?? deps.ptyOutputBuffer.get(ovrId);
  return { ovrId, chunks };
}

/** History length = the longer of the live replay buffer and the disk log —
 *  either may be what a reopen shows (disk wins after a server restart). */
export function shellHistoryLines(deps: ShellHistoryDeps, id: string): { lines: number } | { error: string; status: number } {
  const r = resolveRaw(deps, id);
  if ('error' in r) return r;
  const bufLines = r.chunks?.length ? countLines(Buffer.concat(r.chunks)) : 0;
  return { lines: Math.max(bufLines, countLines(readAll(r.ovrId))) };
}

export function trimShellHistory(deps: ShellHistoryDeps, id: string, keepLines: number): { lines: number } | { error: string; status: number } {
  const r = resolveRaw(deps, id);
  if ('error' in r) return r;
  const bufLines = r.chunks ? trimChunks(r.chunks, keepLines) : 0;
  const diskLines = trimLog(r.ovrId, keepLines);
  console.log(`[shell-history] trimmed ovrId=${r.ovrId.slice(0, 8)} keep=${keepLines} → buf=${bufLines} disk=${diskLines}`);
  return { lines: Math.max(bufLines, diskLines) };
}

export function registerShellHistoryRoutes(app: Express, deps: ShellHistoryDeps): void {
  app.get('/api/sessions/:id/shell-history', (req, res) => {
    const out = shellHistoryLines(deps, req.params.id);
    if ('error' in out) { res.status(out.status).json({ error: out.error }); return; }
    res.json(out);
  });

  app.post('/api/sessions/:id/shell-history/trim', express.json(), (req, res) => {
    const raw = (req.body as { keepLines?: unknown } | undefined)?.keepLines;
    const keepLines = raw === undefined ? DEFAULT_KEEP_LINES : Number(raw);
    if (!Number.isInteger(keepLines) || keepLines < 0) { res.status(400).json({ error: 'keepLines must be a non-negative integer' }); return; }
    const out = trimShellHistory(deps, req.params.id, keepLines);
    if ('error' in out) { res.status(out.status).json({ error: out.error }); return; }
    res.json(out);
  });
}
