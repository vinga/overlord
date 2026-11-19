import express, { type Express } from 'express';
import type { StateManager } from '../session/stateManager.js';
import { resolveTranscriptPath } from '../session/stateManager.js';
import { findTranscriptPathAnywhere } from '../session/transcriptReader.js';
import { extractQuestions, readConversation, type SessionQuestion } from '../session/questionIndex.js';
import { readStars, setStar } from '../session/questionStars.js';

export interface QuestionDeps {
  stateManager: Pick<StateManager, 'getSession' | 'getActiveClaudeByOvr'>;
  /** Injected for tests; defaults to the session's own transcript lookup. */
  transcriptPathFor?: (sessionId: string) => string | null;
}

function lookup(deps: QuestionDeps, id: string): { overlordId: string; transcript: string | null } {
  const session = deps.stateManager.getSession(id) ?? deps.stateManager.getActiveClaudeByOvr(id);
  const sid = session?.sessionId ?? id;
  const transcript = deps.transcriptPathFor
    ? deps.transcriptPathFor(sid)
    : (session ? resolveTranscriptPath(session) : null) ?? findTranscriptPathAnywhere(sid);
  return { overlordId: session?.overlordId ?? id, transcript };
}

/** Questions of a session's current transcript, plus starred messages. */
export function sessionQuestions(deps: QuestionDeps, id: string): { questions: SessionQuestion[]; starred: string[] } {
  const { overlordId, transcript } = lookup(deps, id);
  const starred = readStars(overlordId);
  if (!transcript) return { questions: [], starred };
  return { questions: extractQuestions(readConversation(transcript), new Set(starred)), starred };
}

export function registerQuestionRoutes(app: Express, deps: QuestionDeps): void {
  app.get('/api/sessions/:id/questions', (req, res) => {
    try {
      res.json(sessionQuestions(deps, req.params.id));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/sessions/:id/questions/star', express.json(), (req, res) => {
    const { id: messageId, starred } = (req.body ?? {}) as { id?: unknown; starred?: unknown };
    if (typeof messageId !== 'string' || !messageId || messageId.length > 64 || typeof starred !== 'boolean') {
      res.status(400).json({ error: 'body must be { id: string, starred: boolean }' });
      return;
    }
    const { overlordId } = lookup(deps, req.params.id);
    res.json({ starred: setStar(overlordId, messageId, starred) });
  });
}
