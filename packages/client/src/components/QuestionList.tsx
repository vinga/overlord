import { useMemo, useState } from 'react';
import { jumpToMessage, setQuestionStar, shortAge, type SessionQuestion } from '../lib/questions';
import styles from './QuestionList.module.css';

type Filter = 'all' | 'starred';

/** Q&A tab of the session context column: the user's questions (and starred
 *  messages), newest first, each with the end of the agent's answer. A click
 *  scrolls the conversation to the message. */
export function QuestionList({ sessionId, questions, starred, loaded }: {
  sessionId: string;
  questions: SessionQuestion[];
  starred: ReadonlySet<string>;
  loaded: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
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
          return (
            <li key={q.id} className={styles.row} data-starred={isStarred || undefined}>
              <button type="button" className={styles.main} onClick={() => jumpToMessage(sessionId, q.id)} title="Show in conversation">
                <span className={styles.top}>
                  <span className={styles.question}>{q.question}</span>
                  <span className={styles.age}>{shortAge(q.id, now)}</span>
                </span>
                {q.answer
                  ? <span className={styles.answer}>{q.answer}</span>
                  : <span className={styles.waiting}>Waiting for answer</span>}
              </button>
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
            </li>
          );
        })}
      </ul>
    </div>
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
