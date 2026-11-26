import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { fetchAnswer, jumpToMessage, setQuestionStar, shortAge, type SessionQuestion } from '../lib/questions';
import { renderMarkdown } from '../lib/renderMarkdown';
import styles from './QuestionList.module.css';

type Filter = 'all' | 'starred';

/** Q&A tab of the session context column: the user's questions (and starred
 *  messages), newest first, each with the end of the agent's answer. A click
 *  on the question scrolls the conversation to the question, a click on the
 *  answer to the answer; the chevron expands the full answer in place. */
export function QuestionList({ sessionId, questions, starred, loaded }: {
  sessionId: string;
  questions: SessionQuestion[];
  starred: ReadonlySet<string>;
  loaded: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const rows = useMemo(() => {
    const list = filter === 'starred' ? questions.filter(q => starred.has(q.id)) : questions;
    return [...list].reverse();
  }, [questions, starred, filter]);
  const now = Date.now();

  return (
    <div className={styles.wrap}>
      <div className={styles.filters} role="radiogroup" aria-label="Filter questions">
        {(['all', 'starred'] as const).map(f => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={filter === f}
            className={filter === f ? styles.filterActive : ''}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? `All ${questions.length}` : `Starred ${questions.filter(q => starred.has(q.id)).length}`}
          </button>
        ))}
      </div>
      {!loaded && <p className={styles.muted}>Loading…</p>}
      {loaded && rows.length === 0 && (
        <p className={styles.muted}>
          {filter === 'starred' ? 'Nothing starred yet. Star a message from its hover menu in the conversation.' : 'No questions yet.'}
        </p>
      )}
      <ul className={styles.list}>
        {rows.map(q => {
          const isStarred = starred.has(q.id);
          const answerAt = q.answer ? q.answerAt : undefined;
          const isOpen = !!answerAt && expanded.has(q.id);
          return (
            <li key={q.id} className={styles.row} data-starred={isStarred || undefined} data-open={isOpen || undefined}>
              <div className={styles.main}>
                <button type="button" className={styles.qBtn} onClick={() => jumpToMessage(sessionId, q.id)} title="Show the question in the conversation">
                  <span className={styles.question}>{q.question}</span>
                  <span className={styles.age}>{shortAge(q.id, now)}</span>
                </button>
                {!q.answer && <span className={styles.waiting}>Waiting for answer</span>}
                {q.answer && !isOpen && (
                  <button
                    type="button"
                    className={styles.aBtn}
                    onClick={() => { if (answerAt) jumpToMessage(sessionId, answerAt); }}
                    title="Show the answer in the conversation"
                  >
                    <span className={styles.answer}>{q.answer}</span>
                  </button>
                )}
                {isOpen && answerAt && <FullAnswer sessionId={sessionId} answerAt={answerAt} />}
              </div>
              <div className={styles.side}>
                {answerAt && (
                  <button
                    type="button"
                    className={styles.expand}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'Collapse answer' : 'Expand answer'}
                    title={isOpen ? 'Collapse answer' : 'Show the full answer here'}
                    onClick={() => toggle(q.id)}
                  >
                    <ChevronIcon />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.star}
                  aria-pressed={isStarred}
                  aria-label={isStarred ? 'Unstar' : 'Star'}
                  title={isStarred ? 'Unstar' : 'Star — keep it in the Starred list'}
                  onClick={() => setQuestionStar(sessionId, q.id, !isStarred)}
                >
                  <StarIcon filled={isStarred} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The whole answer as markdown. A click (not a text selection or a link)
 *  scrolls the conversation to it. */
function FullAnswer({ sessionId, answerAt }: { sessionId: string; answerAt: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null); setFailed(false);
    fetchAnswer(sessionId, answerAt)
      .then(t => { if (live) setText(t); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [sessionId, answerAt]);
  const html = useMemo(() => (text === null ? '' : renderMarkdown(text)), [text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    jumpToMessage(sessionId, answerAt);
  };
  if (failed) return <span className={styles.waiting}>Could not load the answer.</span>;
  if (text === null) return <span className={styles.loadingAnswer}>Loading…</span>;
  return (
    <div
      className={styles.full}
      onClick={onClick}
      title="Click to show the answer in the conversation"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ChevronIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StarIcon({ filled, size = 12 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.8l1.85 3.9 4.25.5-3.15 2.9.85 4.2L8 11.2l-3.8 2.1.85-4.2L1.9 6.2l4.25-.5z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
