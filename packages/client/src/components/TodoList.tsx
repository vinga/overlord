import React, { useEffect, useMemo, useState } from 'react';
import type { Pin } from '../types';
import { deletePin } from './PinBar';
import styles from './TodoList.module.css';

interface Props {
  /** All pins of the session or room; only `kind: 'todo'` ones are listed. */
  pins: Pin[] | undefined;
  overlordId?: string;
  cwd?: string;
  /** Section heading class from the host panel, so the list sits in its rhythm. */
  headClassName?: string;
}

const target = (overlordId?: string, cwd?: string) =>
  overlordId !== undefined ? { overlordId } : { cwd: cwd ?? '' };

export function setTodoDone(pinId: string, done: boolean, t: { overlordId?: string; cwd?: string }): Promise<Response> {
  return fetch(`/api/pins/${encodeURIComponent(pinId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...t, done, by: 'user' }),
  });
}

/** TODO pins as a checklist: open items first (oldest on top), checked ones
 *  struck through below. The agent checks items off with `ovr todo done`. */
export function TodoList({ pins, overlordId, cwd, headClassName }: Props) {
  const todos = useMemo(() => (pins ?? []).filter(p => p.kind === 'todo'), [pins]);
  // Optimistic ticks until the snapshot carries the change.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => { setPending({}); }, [pins]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isDone = (p: Pin) => pending[p.id] ?? !!p.done;
  const ordered = [...todos.filter(p => !isDone(p)), ...todos.filter(isDone)];
  const doneCount = todos.filter(isDone).length;
  const t = target(overlordId, cwd);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      const res = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, kind: 'todo', url: '', text }),
      });
      if (!res.ok) { setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      setDraft('');
    } catch {
      setError('Server unreachable');
    }
  };

  const toggle = (p: Pin) => {
    const next = !isDone(p);
    setPending(prev => ({ ...prev, [p.id]: next }));
    void setTodoDone(p.id, next, t).catch(() => setPending(prev => { const { [p.id]: _, ...rest } = prev; return rest; }));
  };

  return (
    <div className={styles.list}>
      <h3 className={headClassName}>
        TODO{todos.length > 0 && <span className={styles.count}>{doneCount}/{todos.length}</span>}
      </h3>
      {ordered.map(p => {
        const done = isDone(p);
        return (
          <div key={p.id} className={`${styles.item} ${done ? styles.done : ''}`} data-todo={p.id}>
            <label className={styles.check}>
              <input type="checkbox" checked={done} onChange={() => toggle(p)} aria-label={p.text} />
              <span className={styles.text}>{p.text}</span>
            </label>
            {done && p.doneBy === 'agent' && pending[p.id] === undefined && (
              <span className={styles.by} title="Checked off by the agent">agent</span>
            )}
            <button type="button" className={styles.remove} aria-label={`Remove TODO ${p.text}`} title="Remove"
              onClick={() => deletePin(p.id, t)}>×</button>
          </div>
        );
      })}
      <input
        className={styles.add}
        value={draft}
        placeholder="Add TODO…"
        aria-label="Add TODO"
        maxLength={300}
        onChange={e => { setDraft(e.target.value); setError(null); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); void add(); }
          else if (e.key === 'Escape') setDraft('');
        }}
      />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
