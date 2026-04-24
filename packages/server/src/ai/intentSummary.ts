import * as fs from 'fs';
import { StateManager } from '../session/stateManager.js';
import { sessionStore } from '../session/sessionStore.js';
import { runClaudeQuery } from './claudeQuery.js';
import { findTranscriptPathAnywhere } from '../session/transcriptReader.js';
import { globalSettingsStore } from '../session/globalSettingsStore.js';

export interface IntentRecord {
  sessionId: string;
  intent: string;
  turnCount: number;
  updatedAt: number;
}

const REFRESH_THRESHOLD = 5;
const DEBOUNCE_MS = 2_000;
const TURN_MIN = 5;
const TURN_MAX = 8;
const TURN_CHAR_CAP = 500;
const TOTAL_CHAR_CAP = 3_000;
const OUTPUT_CHAR_CAP = 60;
const HAIKU_TIMEOUT_MS = 20_000;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const INTENT_PROMPT = `Summarize a Claude Code session for a dashboard card.

Output: ONE short phrase, 3-8 words, no period.
Style: noun phrase or gerund. Present tense.
Examples:
  "Refactoring Brain tab to room level"
  "Debugging WebSocket reconnect loop"
  "Adding PR badge to room header"

Rules:
- No preamble, no quotes, no explanation.
- If work pivoted, describe the most recent thread.
- If unclear, output: "Exploring codebase".

User messages (most recent last):
`;

export class IntentSummarizer {
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();

  constructor(private stateManager: StateManager) {}

  getIntent(sessionId: string): IntentRecord | null {
    const rec = sessionStore.getBySessionId(sessionId);
    if (!rec || typeof rec.intent !== 'string') return null;
    return {
      sessionId,
      intent: rec.intent,
      turnCount: rec.intentTurnCount ?? 0,
      updatedAt: rec.intentUpdatedAt ?? 0,
    };
  }

  /** Push persisted intent into live state on startup (covers restart). */
  hydrate(): void {
    for (const rec of sessionStore.listActive()) {
      if (typeof rec.intent !== 'string') continue;
      const sid = rec.lineage.currentSessionId;
      const session = this.stateManager.getSession(sid);
      if (session) this.stateManager.setIntent(sid, rec.intent);
    }
  }

  maybeRefreshIntent(sessionId: string, cwd: string): void {
    if (globalSettingsStore.get().disableBackgroundLLM) return;
    const session = this.stateManager.getSession(sessionId);
    if (!session) return;

    // Push persisted intent to live state on first observation (survives server restart).
    const cached = sessionStore.getBySessionId(sessionId);
    if (cached?.intent && session.intent !== cached.intent) {
      this.stateManager.setIntent(sessionId, cached.intent);
    }

    if (session.state === 'closed') return;

    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      void this.tryGenerate(sessionId, cwd);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(sessionId, timer);
  }

  private async tryGenerate(sessionId: string, cwd: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    if (globalSettingsStore.get().disableBackgroundLLM) return;

    const session = this.stateManager.getSession(sessionId);
    if (!session || session.state === 'closed') return;

    const transcriptPath = session.transcriptPath ?? findTranscriptPathAnywhere(sessionId);
    if (!transcriptPath) return;

    const turns = readLastUserTurns(transcriptPath, TURN_MAX);
    if (turns.length < 1) return;

    const turnCount = turns.length;
    const storeRec = sessionStore.getBySessionId(sessionId);
    if (storeRec && typeof storeRec.intentTurnCount === 'number'
        && turnCount - storeRec.intentTurnCount < REFRESH_THRESHOLD) return;

    const trimmed = turns
      .slice(-TURN_MAX)
      .slice(-Math.max(TURN_MIN, Math.min(TURN_MAX, turns.length)))
      .map(t => t.slice(0, TURN_CHAR_CAP));

    const joined = trimmed.join('\n---\n').slice(-TOTAL_CHAR_CAP);
    const prompt = INTENT_PROMPT + joined;

    this.inFlight.add(sessionId);
    try {
      console.log(`[intent] ${sessionId.slice(0, 8)} generating (turns=${turnCount})...`);
      const raw = await runClaudeQuery(prompt, HAIKU_TIMEOUT_MS, () => {
        const s = this.stateManager.getSession(sessionId);
        if (!s || s.state === 'closed') return false;
        const fresher = sessionStore.getBySessionId(sessionId);
        if (fresher && typeof fresher.intentTurnCount === 'number' && fresher.intentTurnCount >= turnCount) return false;
        return true;
      });
      const cleaned = raw.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '');
      if (!cleaned || cleaned.length > OUTPUT_CHAR_CAP || /[\r\n]/.test(cleaned)) {
        console.warn(`[intent] ${sessionId.slice(0, 8)} rejected output: "${cleaned.slice(0, 80)}"`);
        return;
      }
      const now = Date.now();
      const liveSession = this.stateManager.getSession(sessionId);
      if (liveSession) sessionStore.ensureFromLive(liveSession);
      sessionStore.patchBySessionId(sessionId, { intent: cleaned, intentTurnCount: turnCount, intentUpdatedAt: now });
      this.stateManager.setIntent(sessionId, cleaned);
      console.log(`[intent] ${sessionId.slice(0, 8)} → "${cleaned}"`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'invalidated') console.warn(`[intent] ${sessionId.slice(0, 8)} failed:`, msg);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

}

function readLastUserTurns(transcriptPath: string, max: number): string[] {
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    } finally {
      fs.closeSync(fd);
    }
    const tail = buf.toString('utf-8');
    const lines = tail.split('\n').filter(l => l.trim());
    if (stat.size > TRANSCRIPT_TAIL_BYTES && lines.length > 1) lines.shift();

    const collected: string[] = [];
    for (let i = lines.length - 1; i >= 0 && collected.length < max; i--) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
          payload?: { role?: string; content?: Array<{ text?: string }> };
        };
        let text = '';
        if (parsed.type === 'user') {
          const c = parsed.message?.content;
          const arr = Array.isArray(c) ? c : [];
          const tb = arr.find((b: { type?: string; text?: string }) => b.type === 'text');
          text = (typeof tb?.text === 'string' ? tb.text : typeof c === 'string' ? c : '').trim();
          if (text.startsWith('<environment_details') || text.startsWith('<local-command') || text.startsWith('<command-name>')) text = '';
          const envIdx = text.indexOf('<environment_details');
          if (envIdx > 0) text = text.slice(0, envIdx).trim();
        }
        if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
          const raw = (parsed.payload.content ?? []).map(b => b.text ?? '').join(' ').trim();
          if (!raw.startsWith('<environment_context>')) text = raw;
        }
        if (text.length >= 4) collected.unshift(text);
      } catch { /* skip malformed */ }
    }
    return collected;
  } catch {
    return [];
  }
}
