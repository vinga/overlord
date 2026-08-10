import React from 'react';
import type { PendingQuestionSet } from '../types';

// The AskUserQuestion TUI appends these two rows after the model-authored options.
// The screen parser tags them when it sees them; transcript-derived question sets
// only carry the model's own options, so we synthesize them at the same trailing
// positions — arrow-key index still lines up with what the TUI renders.
const BUILTIN_OPTIONS = [
  { label: 'Type something', description: 'Dismiss the options and answer in the message box', builtin: true },
  { label: 'Chat about this', description: 'Dismiss the options and reply in chat', builtin: true },
];

export function QuestionPrompt({ sessionId, questionSet, initialStage, onStageChange, onDismissedToChat, styles }: {
  sessionId: string;
  questionSet: PendingQuestionSet;
  initialStage: number;
  onStageChange: (stage: number) => void;
  /** Called after a built-in option is committed — the TUI is back at its normal
   *  composer, so the panel focuses the message box for the free-text reply. */
  onDismissedToChat?: () => void;
  styles: Record<string, string>;
}) {
  const [stage, setStage] = React.useState(initialStage);
  const [responding, setResponding] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);

  const questions = questionSet.questions ?? [];
  if (questions.length === 0) return null;
  const question = questions[stage];
  if (!question) return null;
  const total = questions.length;
  // A CLI-owned modal (resume-from-summary, compaction) renders exactly the rows it
  // shows — no built-ins to synthesize. Adding them would send arrows past the last
  // row, which wraps the selection back to the top and picks the wrong option.
  const isSystem = questionSet.kind === 'system';
  const options = isSystem || question.options.some(o => o.builtin)
    ? question.options
    : [...question.options, ...BUILTIN_OPTIONS];

  // AskUserQuestion TUI uses arrow-key navigation.
  // We send arrows first, wait for the TUI to process them, then send Enter.
  const doInject = async (text: string, raw = false) => {
    const r = await fetch(`/api/sessions/${sessionId}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, raw }),
    });
    if (!r.ok) throw new Error(`inject failed: ${r.status}`);
  };

  const respond = async (optionIndex: number, label: string, builtin = false) => {
    setResponding(true);
    setSelected(label);
    setError(false);
    try {
      // Send each arrow individually (raw=true so no auto-appended \r), then Enter
      for (let i = 0; i < optionIndex; i++) {
        await doInject('\x1b[B', true);
        await new Promise(r => setTimeout(r, 80));
      }
      await doInject('\r');
      if (builtin) {
        // "Type something" / "Chat about this" decline the whole question set and
        // drop the TUI back to its normal composer — no review/submit step, and no
        // further questions in this set. Hand the user straight to the message box.
        onStageChange(0);
        onDismissedToChat?.();
        return;
      }
      if (stage < total - 1) {
        // Advance to next question after a brief pause
        setTimeout(() => {
          const next = stage + 1;
          setStage(next);
          onStageChange(next);
          setSelected(null);
          setResponding(false);
        }, 400);
      } else {
        // Last question answered — the AskUserQuestion TUI shows a "Review + Submit"
        // confirmation step; auto-confirm it with Enter (option 1) after a delay. A
        // system modal commits on the first Enter and is already back at the composer,
        // so a second one would submit an empty message to Claude.
        if (!isSystem) setTimeout(() => void doInject('\r').catch(() => null), 600);
        // Clear persisted stage so next question set starts at 0
        onStageChange(0);
        // Leave responding=true until transcript clears the prompt
      }
    } catch {
      setError(true);
      setSelected(null);
      setResponding(false);
      setTimeout(() => setError(false), 3000);
    }
  };

  return (
    <div className={styles.questionPrompt}>
      <div className={styles.questionMeta}>
        {/* System modals carry no header chip of their own; label them so the choice
            reads as the CLI asking, not the model. */}
        {(question.header || isSystem) && (
          <span className={styles.questionHeader}>{question.header ?? 'Terminal'}</span>
        )}
        {total > 1 && (
          <span className={styles.questionProgress}>{stage + 1} / {total}</span>
        )}
      </div>
      <div className={styles.questionText}>{question.question}</div>
      {options.length > 0 ? (
        <div className={styles.questionOptions}>
          {options.map((opt, i) => (
            <button
              key={i}
              className={`${styles.questionOption} ${opt.builtin ? styles.questionOptionBuiltin : ''} ${selected === opt.label ? styles.questionOptionSelected : ''} ${error ? styles.questionOptionError : ''}`}
              onClick={() => void respond(i, opt.label, opt.builtin === true)}
              disabled={responding}
            >
              <span className={styles.questionOptionNum}>{i + 1}</span>
              <span className={styles.questionOptionBody}>
                <span className={styles.questionOptionLabel}>{opt.label}</span>
                {opt.description && <span className={styles.questionOptionDesc}>{opt.description}</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.questionPromptActions}>
          <button className={`${styles.permissionBtn} ${styles.permissionBtnYes}`} onClick={() => void respond(0, 'Continue')} disabled={responding}>
            {error ? 'Failed' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  );
}
