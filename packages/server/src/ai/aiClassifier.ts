/**
 * Stub holder. Completion classification is gone — guessing "this agent is
 * finished" from the last message was wrong often enough that `waiting` alone
 * is the honest signal. Only the label-scheduling no-ops remain, because
 * transcriptWatcher still calls them.
 */
export class AiClassifier {
  scheduleLabel(_sessionId: string): void {}
  cancelLabel(_sessionId: string): void {}
  hasLabelScheduled(_sessionId: string): boolean { return false; }
  isGeneratingLabel(_sessionId: string): boolean { return false; }
}
