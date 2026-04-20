import { StateManager } from '../session/stateManager.js';

export class AiClassifier {
  constructor(private stateManager: StateManager) {}

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
    // Haiku classification disabled — heuristic only
    const heuristic = this.classifyByHeuristic(lastMessage);
    if (heuristic !== null) {
      console.log(`[classify] ${sessionId.slice(0, 8)} → ${heuristic} (heuristic)`);
      this.stateManager.setCompletionHint(sessionId, heuristic, lastMessage);
    }
  }

  scheduleLabel(_sessionId: string): void {}
  cancelLabel(_sessionId: string): void {}
  hasLabelScheduled(_sessionId: string): boolean { return false; }
  isGeneratingLabel(_sessionId: string): boolean { return false; }
}
