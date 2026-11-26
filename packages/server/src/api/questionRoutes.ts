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

const ANSWER_FULL_MAX = 20_000;

/** The assistant text written at `at` (a question's `answerAt`), or null. */
export function answerText(deps: QuestionDeps, id: string, at: string): string | null {
  const { transcript } = lookup(deps, id);
  if (!transcript) return null;
  const entry = readConversation(transcript).find(e => e.role === 'assistant' && e.timestamp === at);
  if (!entry) return null;
  return entry.text.length > ANSWER_FULL_MAX ? `${entry.text.slice(0, ANSWER_FULL_MAX)}…` : entry.text;
}

export function registerQuestionRoutes(app: Express, deps: QuestionDeps): void {
  app.get('/api/sessions/:id/questions', (req, res) => {
    try {
      res.json(sessionQuestions(deps, req.params.id));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Full text of one answer (the list carries only a clipped preview).
  app.get('/api/sessions/:id/questions/answer', (req, res) => {
    const at = typeof req.query.at === 'string' ? req.query.at : '';
    if (!at || at.length > 64) { res.status(400).json({ error: 'at= is required' }); return; }
    try {
      const text = answerText(deps, req.params.id, at);
      if (text === null) { res.status(404).json({ error: 'answer not found' }); return; }
      res.json({ text });
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
