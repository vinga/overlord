import React from 'react';
import type { PendingQuestionSet } from '../types';

export function QuestionPrompt({ sessionId, questionSet, initialStage, onStageChange, styles }: {
  sessionId: string;
  questionSet: PendingQuestionSet;
  initialStage: number;
  onStageChange: (stage: number) => void;
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

  const respond = async (optionIndex: number, label: string) => {
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
        // Last question answered — TUI shows a "Review + Submit" confirmation step.
        // Auto-confirm by sending Enter (selects "Submit answers", option 1) after a delay.
        setTimeout(() => void doInject('\r').catch(() => null), 600);
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
        {question.header && <span className={styles.questionHeader}>{question.header}</span>}
        {total > 1 && (
          <span className={styles.questionProgress}>{stage + 1} / {total}</span>
        )}
      </div>
      <div className={styles.questionText}>{question.question}</div>
      {question.options.length > 0 ? (
        <div className={styles.questionOptions}>
          {question.options.map((opt, i) => (
            <button
              key={i}
              className={`${styles.questionOption} ${selected === opt.label ? styles.questionOptionSelected : ''} ${error ? styles.questionOptionError : ''}`}
              onClick={() => void respond(i, opt.label)}
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
