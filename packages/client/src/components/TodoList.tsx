import React, { useEffect, useMemo, useState } from 'react';
import type { Pin } from '../types';
import { deletePin, copyPinToRoom, pinInRoom, ToRoomButton } from './PinBar';
import styles from './TodoList.module.css';

interface Props {
  /** All pins of the session or room; only `kind: 'todo'` ones are listed. */
  pins: Pin[] | undefined;
  overlordId?: string;
  cwd?: string;
  /** Section heading class from the host panel, so the list sits in its rhythm. */
  headClassName?: string;
  /** Session lists: the session's room, so each item can be copied there. */
  roomCwd?: string;
  /** That room's pins, to light items it already holds. */
  roomPins?: Pin[];
}

const target = (overlordId?: string, cwd?: string) =>
  overlordId !== undefined ? { overlordId } : { cwd: cwd ?? '' };

type Owner = 'user' | 'agent';
type Tab = 'all' | Owner;
const ownerOf = (p: Pin): Owner => (p.owner === 'agent' ? 'agent' : 'user');

export function setTodoOwner(pinId: string, owner: Owner, t: { overlordId?: string; cwd?: string }): Promise<Response> {
  return fetch(`/api/pins/${encodeURIComponent(pinId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...t, owner }),
  });
}

const PersonIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <circle cx="8" cy="5.5" r="2.75" />
    <path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4" strokeLinecap="round" />
  </svg>
);
const BotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <rect x="2.5" y="5" width="11" height="8.5" rx="2.25" />
    <path d="M8 5V2.5" strokeLinecap="round" />
    <circle cx="8" cy="2" r=".9" fill="currentColor" stroke="none" />
    <circle cx="5.75" cy="9" r="1" fill="currentColor" stroke="none" />
    <circle cx="10.25" cy="9" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export function setTodoDone(pinId: string, done: boolean, t: { overlordId?: string; cwd?: string }): Promise<Response> {
  return fetch(`/api/pins/${encodeURIComponent(pinId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...t, done, by: 'user' }),
  });
}

/** TODO pins as a checklist: open items first (oldest on top), checked ones
 *  struck through below. Each item is the user's or the agent's (bot icon;
 *  click the icon to hand it over); anyone may check any item. Tabs filter by
 *  owner, and a new item belongs to the active tab's owner (All → user).
 *  The agent works its side with `ovr todo ls --agent` / `ovr todo done`. */
export function TodoList({ pins, overlordId, cwd, headClassName, roomCwd, roomPins }: Props) {
  const todos = useMemo(() => (pins ?? []).filter(p => p.kind === 'todo'), [pins]);
  // Optimistic ticks until the snapshot carries the change.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [pendingOwner, setPendingOwner] = useState<Record<string, Owner>>({});
  useEffect(() => { setPending({}); setPendingOwner({}); }, [pins]);
  const [tab, setTab] = useState<Tab>('all');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isDone = (p: Pin) => pending[p.id] ?? !!p.done;
  const owner = (p: Pin) => pendingOwner[p.id] ?? ownerOf(p);
  const shown = tab === 'all' ? todos : todos.filter(p => owner(p) === tab);
  const ordered = [...shown.filter(p => !isDone(p)), ...shown.filter(isDone)];
  const agentCount = todos.filter(p => owner(p) === 'agent').length;
  const tabs: Array<{ key: Tab; label: string; n: number }> = [
    { key: 'all', label: 'All', n: todos.length },
    { key: 'user', label: 'User', n: todos.length - agentCount },
    { key: 'agent', label: 'Agent', n: agentCount },
  ];
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
        body: JSON.stringify({ ...t, kind: 'todo', url: '', text, owner: tab === 'agent' ? 'agent' : 'user' }),
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

  const flipOwner = (p: Pin) => {
    const next: Owner = owner(p) === 'agent' ? 'user' : 'agent';
    setPendingOwner(prev => ({ ...prev, [p.id]: next }));
    void setTodoOwner(p.id, next, t).catch(() => setPendingOwner(prev => { const { [p.id]: _, ...rest } = prev; return rest; }));
  };

  return (
    <div className={styles.list}>
      <h3 className={headClassName}>
        TODO{todos.length > 0 && <span className={styles.count}>{doneCount}/{todos.length}</span>}
      </h3>
      {todos.length > 0 && (
        <div className={styles.tabs} role="tablist" aria-label="Filter TODOs by owner">
          {tabs.map(x => (
            <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} data-tab={x.key}
              className={`${styles.tab} ${tab === x.key ? styles.tabOn : ''}`} onClick={() => setTab(x.key)}>
              {x.label}<span className={styles.tabCount}>{x.n}</span>
            </button>
          ))}
        </div>
      )}
      {ordered.map(p => {
        const done = isDone(p);
        const mine = owner(p) === 'agent';
        return (
          <div key={p.id} className={`${styles.item} ${done ? styles.done : ''}`} data-todo={p.id} data-owner={owner(p)}>
            <label className={styles.check}>
              <input type="checkbox" checked={done} onChange={() => toggle(p)} aria-label={p.text} />
              <span className={styles.text}>{p.text}</span>
            </label>
            <button type="button" className={`${styles.owner} ${mine ? styles.ownerAgent : ''}`}
              title={mine ? "Agent's item — click to give it to the user" : "User's item — click to give it to the agent"}
              aria-label={mine ? `Give ${p.text} to the user` : `Give ${p.text} to the agent`}
              onClick={() => flipOwner(p)}>
              {mine ? <BotIcon /> : <PersonIcon />}
            </button>
            {/* The bot icon already marks the agent's own items; the tag only says
                the agent checked off one of the user's. */}
            {done && !mine && p.doneBy === 'agent' && pending[p.id] === undefined && (
              <span className={styles.by} title="Checked off by the agent">agent</span>
            )}
            {roomCwd !== undefined && overlordId !== undefined && (
              <ToRoomButton className={styles.toRoom} onCopy={() => copyPinToRoom(p, roomCwd)} inRoom={pinInRoom(p, roomPins)} />
            )}
            <button type="button" className={styles.remove} aria-label={`Remove TODO ${p.text}`} title="Remove"
              onClick={() => deletePin(p.id, t)}>×</button>
          </div>
        );
      })}
      <input
        className={styles.add}
        value={draft}
        placeholder={tab === 'agent' ? 'Add TODO for the agent…' : 'Add TODO…'}
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
