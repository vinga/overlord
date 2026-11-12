import { useEffect, useRef, useState } from 'react';
import { SessionNotesEditor } from './SessionNotesEditor';
import { updateNoteFirstLine } from '../hooks/useNotesSummaries';
import styles from './ContextView.module.css';

/** What a context column shows: its usual cards, or one of three notes —
 *  the session's, the room's, or the global scratchpad. */
export type ContextView = 'context' | 'notes' | 'room' | 'global';
const VIEWS: readonly ContextView[] = ['context', 'notes', 'room', 'global'];

function readViews(storageKey: string): Record<string, ContextView> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? raw as Record<string, ContextView> : {};
  } catch { return {}; }
}

function loadView(storageKey: string, id: string | undefined, allowed: readonly ContextView[]): ContextView {
  const v = id ? readViews(storageKey)[id] : undefined;
  return v && VIEWS.includes(v) && allowed.includes(v) ? v : 'context';
}

function saveView(storageKey: string, id: string, view: ContextView): void {
  try {
    const views = readViews(storageKey);
    if (view === 'context') delete views[id]; else views[id] = view;
    localStorage.setItem(storageKey, JSON.stringify(views));
  } catch { /* per-viewer convenience only */ }
}

/** The column's view, remembered per id (session or room) in one localStorage
 *  map. Absent means the default view, so only ids switched away take space. */
export function useContextView(storageKey: string, id: string | undefined, allowed: readonly ContextView[]): [ContextView, (next: ContextView) => void] {
  const [view, setView] = useState<ContextView>(() => loadView(storageKey, id, allowed));
  // `allowed` is a module constant at every call site.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setView(loadView(storageKey, id, allowed)); }, [storageKey, id]);
  const switchView = (next: ContextView) => {
    setView(next);
    if (id) saveView(storageKey, id, next);
  };
  return [view, switchView];
}

export interface ContextTab { view: ContextView; label: string; title?: string }

export function ContextViewSwitch({ tabs, view, onChange }: { tabs: readonly ContextTab[]; view: ContextView; onChange: (v: ContextView) => void }) {
  return (
    <div className={styles.viewSwitch} role="tablist" aria-label="Context view">
      {tabs.map(t => (
        <button
          key={t.view}
          type="button"
          role="tab"
          aria-selected={view === t.view}
          title={t.title}
          className={view === t.view ? styles.viewActive : ''}
          onClick={() => onChange(t.view)}
        >{t.label}</button>
      ))}
    </div>
  );
}

const SAVE_DELAY_MS = 500;

interface NotesProps {
  /** Reload whenever this changes (session or room identity). */
  id: string;
  load: () => Promise<string>;
  save: (notes: string) => Promise<unknown>;
  placeholder?: string;
}

/** Notes in a context column. Loads on mount, saves 500ms after the last
 *  keystroke, and flushes a pending save when the view switches away. */
function ContextNotes({ id, load, save, placeholder }: NotesProps) {
  const [notes, setNotes] = useState<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: string } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    load()
      .then(v => { if (!cancelled) setNotes(v); })
      .catch(() => { if (!cancelled) setNotes(''); });
    return () => {
      cancelled = true;
      const p = pending.current;
      if (p) { clearTimeout(p.timer); void saveRef.current(p.value).catch(() => {}); pending.current = null; }
    };
    // `load` is a fresh closure each render; `id` is what identifies the notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (notes === null) return <p className={styles.loading}>Loading…</p>;

  return (
    <div className={styles.notesView}>
      <SessionNotesEditor
        value={notes}
        placeholder={placeholder}
        onChange={value => {
          setNotes(value);
          if (pending.current) clearTimeout(pending.current.timer);
          const timer = setTimeout(() => { pending.current = null; void saveRef.current(value).catch(() => {}); }, SAVE_DELAY_MS);
          pending.current = { timer, value };
        }}
      />
    </div>
  );
}

/** The session's notes — same store as the session's Notes tab. */
export function SessionContextNotes({ sessionId }: { sessionId: string }) {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/notes`;
  return (
    <ContextNotes
      id={sessionId}
      load={() => fetch(url).then(r => r.json() as Promise<{ notes?: string }>).then(d => d.notes ?? '')}
      save={notes => fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      }).then(() => updateNoteFirstLine(sessionId, notes))}
    />
  );
}

/** The room's notes — the room config's `description`, also edited in the
 *  room's Details tab. */
export function RoomContextNotes({ cwd }: { cwd: string }) {
  return (
    <ContextNotes
      id={cwd}
      placeholder="Describe this room… headings, bullets, links"
      load={() => fetch(`/api/room-config?cwd=${encodeURIComponent(cwd)}`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ description?: string }>; })
        .then(d => d.description ?? '')}
      save={description => fetch('/api/room-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, description }),
      })}
    />
  );
}

/** The global scratchpad — the same file as the header's scratchpad popup. */
export function GlobalContextNotes() {
  return (
    <ContextNotes
      id="global"
      placeholder="Notes for every room and session…"
      load={() => fetch('/api/scratchpad').then(r => r.json() as Promise<{ content?: string }>).then(d => d.content ?? '')}
      save={content => fetch('/api/scratchpad', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })}
    />
  );
}
