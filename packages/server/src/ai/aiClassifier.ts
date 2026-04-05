import * as fs from 'fs';
import { StateManager } from '../session/stateManager.js';
import { runClaudeQuery } from './claudeQuery.js';
import { findTranscriptPathAnywhere } from '../session/transcriptReader.js';
import { appendTaskSummary } from './taskStorage.js';

export class AiClassifier {
  // Per-session debounce timers for active task label generation
  private activeTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeLabelGenerations = new Set<string>();

  constructor(private stateManager: StateManager) {}

  async generateActiveLabel(sessionId: string): Promise<void> {
    this.activeTaskTimers.delete(sessionId);
    if (this.activeLabelGenerations.has(sessionId)) return;
    this.activeLabelGenerations.add(sessionId);

    try {
      const session = this.stateManager.getSession(sessionId);
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
          const s = this.stateManager.getSession(sessionId);
          return s != null && (s.state === 'working' || s.state === 'thinking');
        });
        const label = raw.trim().replace(/^["']|["']$/g, '').slice(0, 40);
        // Only apply if still working/thinking
        const current = this.stateManager.getSession(sessionId);
        if (current && (current.state === 'working' || current.state === 'thinking')) {
          console.log(`[label] ${sessionId.slice(0, 8)} → "${label}"`);
          this.stateManager.setCurrentTaskLabel(sessionId, label);
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== 'invalidated') console.warn(`[label] ${sessionId.slice(0, 8)} failed:`, msg);
      }
    } finally {
      this.activeLabelGenerations.delete(sessionId);
    }
  }

  classifyByHeuristic(message: string): 'done' | 'awaiting' | null {
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

  async classifyCompletion(sessionId: string, lastMessage: string): Promise<void> {
    const heuristic = this.classifyByHeuristic(lastMessage);
    if (heuristic !== null) {
      console.log(`[classify] ${sessionId.slice(0, 8)} → ${heuristic} (heuristic)`);
      this.stateManager.setCompletionHint(sessionId, heuristic, lastMessage);
      if (heuristic === 'done') {
        setTimeout(() => { void this.generateCompletionSummary(sessionId, lastMessage); }, 2_000);
      }
      return;
    }
    try {
      const prompt = `A Claude Code AI agent sent this message to a user. Did it complete a task/request (and is done), or is it asking a question / waiting for more user instructions?\n\nMessage: "${lastMessage.slice(0, 300)}"\n\nReply with exactly one word: done OR awaiting`;
      console.log(`[classify] ${sessionId.slice(0, 8)} querying haiku...`);
      const result = await runClaudeQuery(prompt, 45_000, () => {
        const s = this.stateManager.getSession(sessionId);
        return s?.state === 'waiting' && s?.lastMessage === lastMessage.slice(0, 300);
      });
      const hint = result.toLowerCase().includes('done') ? 'done' : 'awaiting';
      console.log(`[classify] ${sessionId.slice(0, 8)} → ${hint} (raw: "${result.trim()}")`);
      this.stateManager.setCompletionHint(sessionId, hint, lastMessage.slice(0, 300));
      if (hint === 'done') {
        // Wait 2s to confirm state is stable, then generate a one-line summary
        setTimeout(() => { void this.generateCompletionSummary(sessionId, lastMessage); }, 2_000);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'invalidated') console.warn(`[classify] ${sessionId.slice(0, 8)} failed:`, msg);
    }
  }

  async generateCompletionSummary(sessionId: string, forMessage: string): Promise<void> {
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
        const s = this.stateManager.getSession(sessionId);
        return s?.state === 'waiting' && s?.lastMessage === forMessage.slice(0, 300);
      });
      // Only apply if session is still waiting on the same message
      const session = this.stateManager.getSession(sessionId);
      if (!session || session.state !== 'waiting' || session.lastMessage !== forMessage.slice(0, 300)) {
        console.log(`[summary] ${sessionId.slice(0, 8)} skipped — session moved on`);
        return;
      }
      const clean = summary.trim().replace(/^["']|["']$/g, '');
      console.log(`[summary] ${sessionId.slice(0, 8)} → "${clean}"`);
      const updated = await appendTaskSummary(sessionId, clean);
      this.stateManager.setCompletionSummaries(sessionId, updated);
      // If manually marked done, auto-accept the generated summary
      const currentSession = this.stateManager.getSession(sessionId);
      if (currentSession?.completionHintByUser && updated.length > 0) {
        const latest = updated[updated.length - 1];
        this.stateManager.acceptTask(sessionId, latest.completedAt);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'invalidated') console.warn(`[summary] ${sessionId.slice(0, 8)} failed:`, msg);
    }
  }

  /** Sets a 3s debounce timer before generating an active label */
  scheduleLabel(sessionId: string): void {
    if (this.activeTaskTimers.has(sessionId)) {
      clearTimeout(this.activeTaskTimers.get(sessionId)!);
    }
    const timer = setTimeout(() => { void this.generateActiveLabel(sessionId); }, 3_000);
    this.activeTaskTimers.set(sessionId, timer);
  }

  /** Clears a pending label generation timer */
  cancelLabel(sessionId: string): void {
    const timer = this.activeTaskTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activeTaskTimers.delete(sessionId);
    }
  }

  /** Whether a label generation timer is pending for this session */
  hasLabelScheduled(sessionId: string): boolean {
    return this.activeTaskTimers.has(sessionId);
  }

  /** Whether a label generation is currently in-flight for this session */
  isGeneratingLabel(sessionId: string): boolean {
    return this.activeLabelGenerations.has(sessionId);
  }
}
