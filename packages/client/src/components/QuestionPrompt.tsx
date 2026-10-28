import React from 'react';
import type { PendingQuestionOption, PendingQuestionSet } from '../types';

// The AskUserQuestion TUI appends these two rows after the model-authored options.
// The screen parser tags them when it sees them; transcript-derived question sets
// only carry the model's own options, so we synthesize them at the same trailing
// positions — arrow-key index still lines up with what the TUI renders.
const BUILTIN_OPTIONS: PendingQuestionOption[] = [
  { label: 'Type something', description: 'Answer in your own words', builtin: true, freeText: true },
  { label: 'Chat about this', description: 'Dismiss the questions and talk it through in chat', builtin: true },
];

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const BACKSPACE = '\x7f';
const KEY_GAP_MS = 80;

// Older screen sets carry no `freeText` tag; the label is the fallback.
const isFreeText = (o: PendingQuestionOption) =>
  o.freeText === true || (o.builtin === true && /^(?:type something|let me (?:type|answer)|none of the above)/i.test(o.label));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function QuestionPrompt({ sessionId, questionSet, initialStage, onStageChange, onDismissedToChat, styles }: {
  sessionId: string;
  questionSet: PendingQuestionSet;
  initialStage: number;
  onStageChange: (stage: number) => void;
  /** Called after "Chat about this" is committed — the TUI is back at its normal
   *  composer, so the panel focuses the message box for the reply. */
  onDismissedToChat?: () => void;
  styles: Record<string, string>;
}) {
  // A screen set holds only the question on screen; its tab position is in `step`.
  const [stage, setStage] = React.useState(questionSet.step ? 0 : initialStage);
  const [responding, setResponding] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [text, setText] = React.useState('');
  const [textOpen, setTextOpen] = React.useState(false);
  // Row the TUI caret is on. Arrows move relative to it: after a multi-select toggle
  // the caret stays put, and the user may have moved it in the terminal.
  const cursorRef = React.useRef(0);
  const textInputRef = React.useRef<HTMLInputElement>(null);

  const questions = questionSet.questions ?? [];
  const question = questions[stage];
  const total = questions.length;
  // A CLI-owned modal (resume-from-summary, compaction) renders exactly the rows it
  // shows — no built-ins to synthesize. Adding them would send arrows past the last
  // row, which wraps the selection back to the top and picks the wrong option.
  const isSystem = questionSet.kind === 'system';
  const options = React.useMemo(() => {
    if (!question) return [];
    return isSystem || question.options.some(o => o.builtin) ? question.options : [...question.options, ...BUILTIN_OPTIONS];
  }, [question, isSystem]);
  const multi = question?.multiSelect === true && !isSystem;
  const textIdx = isSystem ? -1 : options.findIndex(isFreeText);
  const chatIdx = isSystem ? -1 : options.findIndex(o => o.builtin && !isFreeText(o));
  // A multi-select has an unnumbered "Next"/"Submit" row between "Type something"
  // and "Chat about this"; every row from there on sits one arrow further down.
  const submitRow = chatIdx >= 0 ? chatIdx : options.length;
  const rowOf = (i: number) => (multi && i >= submitRow ? i + 1 : i);

  const step = questionSet.step;
  const stepIndex = step ? step.index : stage;
  const stepCount = step ? step.count : total;
  const isLast = stepIndex >= stepCount - 1;
  // The TUI asks "Review your answers" after the last tab — except for a lone
  // single-select, which commits on its Enter.
  const needsReview = !isSystem && (stepCount > 1 || questions.some(q => q.multiSelect));

  // Fresh question (next tab, next stage, or a new set): reseed from what the screen
  // shows. Keyed on the text, not the object — every snapshot tick rebuilds it.
  const signature = `${stepIndex}|${question?.question ?? ''}`;
  React.useEffect(() => {
    const opts = question?.options ?? [];
    setChecked(new Set(opts.flatMap((o, i) => (o.checked && !isFreeText(o) ? [i] : []))));
    const typed = opts.find(isFreeText)?.value ?? '';
    setText(typed);
    setTextOpen(typed !== '');
    setSelected(null);
    setResponding(false);
    cursorRef.current = question?.cursor ?? 0;
  }, [signature]);
  // Follow the caret when it moves in the terminal — but not mid-injection, when
  // the screen lags our own keystrokes.
  React.useEffect(() => {
    if (!responding && question?.cursor !== undefined) cursorRef.current = question.cursor;
  }, [question?.cursor, responding]);
  React.useEffect(() => {
    if (textOpen) textInputRef.current?.focus();
  }, [textOpen]);

  if (!question) return null;

  const doInject = async (data: string, raw = false) => {
    const r = await fetch(`/api/sessions/${sessionId}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data, raw }),
    });
    if (!r.ok) throw new Error(`inject failed: ${r.status}`);
  };

  // Arrow keys one at a time (raw, so no Enter is appended), paced so Ink
  // processes each before the next.
  const moveTo = async (row: number) => {
    const delta = row - cursorRef.current;
    for (let i = 0; i < Math.abs(delta); i++) {
      await doInject(delta > 0 ? DOWN : UP, true);
      await sleep(KEY_GAP_MS);
    }
    cursorRef.current = row;
  };

  // Replace whatever the "Type something" field holds with `value`. Typing on that
  // row is all it takes — the TUI turns it into the answer (and ticks it in a
  // multi-select).
  const typeInto = async (row: number, value: string) => {
    await moveTo(row);
    const prev = options[textIdx]?.value ?? '';
    for (let i = 0; i < prev.length; i++) await doInject(BACKSPACE, true);
    if (value) await doInject(value, true);
    await sleep(150);
  };

  const run = async (label: string, keys: () => Promise<void>, after: 'advance' | 'chat') => {
    setResponding(true);
    setSelected(label);
    setError(false);
    try {
      await keys();
      if (after === 'chat') {
        // "Chat about this" declines the whole question set and drops the TUI back
        // to its composer — no review step, no further questions.
        onStageChange(0);
        onDismissedToChat?.();
        return;
      }
      if (!isLast) {
        // A screen set's next tab arrives as a new set (the reseed effect resets
        // us); a transcript set advances locally.
        if (!step) {
          setTimeout(() => {
            const next = stage + 1;
            setStage(next);
            onStageChange(next);
          }, 400);
        }
        return;
      }
      // Last question answered. Confirm the review step ("Submit answers" is row 1).
      // A system modal or a lone single-select is already back at the composer, where
      // a second Enter would send Claude an empty message.
      if (needsReview) setTimeout(() => void doInject('\r').catch(() => null), 600);
      onStageChange(0);
      // Leave responding=true until the prompt clears.
    } catch {
      setError(true);
      setSelected(null);
      setResponding(false);
      setTimeout(() => setError(false), 3000);
    }
  };

  const answerSingle = (i: number) => run(options[i]?.label ?? 'Continue', async () => {
    await moveTo(rowOf(i));
    await doInject('\r');
  }, 'advance');

  const answerText = () => {
    const value = text.trim();
    if (!value) return;
    void run(value, async () => {
      await typeInto(rowOf(textIdx), value);
      await doInject('\r');
    }, 'advance');
  };

  const chat = () => run(options[chatIdx].label, async () => {
    await moveTo(rowOf(chatIdx));
    await doInject('\r');
  }, 'chat');

  // Multi-select: ticks are staged here and sent in one go — toggle every row whose
  // screen state differs (Space), fill the text row, then Enter on "Next"/"Submit".
  const submitMulti = () => run(isLast ? 'Submit' : 'Next', async () => {
    for (let i = 0; i < options.length; i++) {
      if (i === textIdx || i === chatIdx) continue;
      if (checked.has(i) === (options[i].checked === true)) continue;
      await moveTo(rowOf(i));
      await doInject(' ', true);
      await sleep(KEY_GAP_MS);
    }
    if (textIdx >= 0 && text.trim() !== (options[textIdx].value ?? '')) {
      await typeInto(rowOf(textIdx), text.trim());
    }
    await moveTo(submitRow);
    await doInject('\r');
  }, 'advance');

  const toggle = (i: number) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const hasMultiAnswer = checked.size > 0 || text.trim() !== '';

  const textField = (
    <div className={styles.questionTextField}>
      <input
        ref={textInputRef}
        className={styles.questionTextInput}
        value={text}
        placeholder="Type your answer…"
        disabled={responding}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (multi) { if (hasMultiAnswer) void submitMulti(); } else answerText();
        }}
      />
      {!multi && (
        <button
          className={`${styles.permissionBtn} ${styles.permissionBtnYes}`}
          onClick={answerText}
          disabled={responding || !text.trim()}
        >
          Send
        </button>
      )}
    </div>
  );

  const renderOption = (opt: PendingQuestionOption, i: number) => {
    const isText = i === textIdx;
    const isChat = i === chatIdx;
    const ticked = multi && (isText ? text.trim() !== '' : checked.has(i));
    const onClick = () => {
      if (isChat) void chat();
      else if (isText) { if (multi) textInputRef.current?.focus(); else setTextOpen(o => !o); }
      else if (multi) toggle(i);
      else void answerSingle(i);
    };
    return (
      <React.Fragment key={i}>
        {multi && isChat && (
          <button
            className={`${styles.permissionBtn} ${styles.permissionBtnYes} ${styles.questionSubmit}`}
            onClick={() => void submitMulti()}
            disabled={responding || !hasMultiAnswer}
          >
            {error ? 'Failed' : isLast ? 'Submit' : 'Next'}
          </button>
        )}
        <button
          className={`${styles.questionOption} ${opt.builtin ? styles.questionOptionBuiltin : ''} ${(selected === opt.label || ticked) ? styles.questionOptionSelected : ''} ${error ? styles.questionOptionError : ''}`}
          onClick={onClick}
          disabled={responding}
          aria-pressed={multi && !isChat ? ticked : undefined}
        >
          {multi && !isChat
            ? <span className={`${styles.questionCheckbox} ${ticked ? styles.questionCheckboxOn : ''}`}>{ticked ? '✓' : ''}</span>
            : <span className={styles.questionOptionNum}>{i + 1}</span>}
          <span className={styles.questionOptionBody}>
            <span className={styles.questionOptionLabel}>{opt.label}</span>
            {opt.description && <span className={styles.questionOptionDesc}>{opt.description}</span>}
          </span>
        </button>
        {isText && (multi || textOpen) && textField}
      </React.Fragment>
    );
  };

  return (
    <div className={styles.questionPrompt}>
      <div className={styles.questionMeta}>
        {/* System modals carry no header chip of their own; label them so the choice
            reads as the CLI asking, not the model. */}
        {(question.header || isSystem) && (
          <span className={styles.questionHeader}>{question.header ?? 'Terminal'}</span>
        )}
        {multi && <span className={styles.questionMultiHint}>Select all that apply</span>}
        {stepCount > 1 && (
          <span className={styles.questionProgress}>{stepIndex + 1} / {stepCount}</span>
        )}
      </div>
      <div className={styles.questionText}>{question.question}</div>
      {options.length > 0 ? (
        <div className={styles.questionOptions}>
          {options.map(renderOption)}
          {multi && chatIdx < 0 && (
            <button
              className={`${styles.permissionBtn} ${styles.permissionBtnYes} ${styles.questionSubmit}`}
              onClick={() => void submitMulti()}
              disabled={responding || !hasMultiAnswer}
            >
              {error ? 'Failed' : isLast ? 'Submit' : 'Next'}
            </button>
          )}
        </div>
      ) : (
        <div className={styles.questionPromptActions}>
          <button className={`${styles.permissionBtn} ${styles.permissionBtnYes}`} onClick={() => void answerSingle(0)} disabled={responding}>
            {error ? 'Failed' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  );
}
