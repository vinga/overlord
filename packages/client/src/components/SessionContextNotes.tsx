import { useEffect, useRef, useState } from 'react';
import { SessionNotesEditor } from './SessionNotesEditor';
import { updateNoteFirstLine } from '../hooks/useNotesSummaries';
import styles from './SessionContextPanel.module.css';

const SAVE_DELAY_MS = 500;

function saveNotes(sessionId: string, notes: string): void {
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  }).then(() => updateNoteFirstLine(sessionId, notes)).catch(() => {});
}

/** The session's notes in the context column — same store and editor as the
 *  session's Notes tab. Loads on mount, saves 500ms after the last keystroke,
 *  and flushes a pending save when the view switches away. */
export function SessionContextNotes({ sessionId }: { sessionId: string }) {
  const [notes, setNotes] = useState<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes`)
      .then(r => r.json() as Promise<{ notes?: string }>)
      .then(data => { if (!cancelled) setNotes(data.notes ?? ''); })
      .catch(() => { if (!cancelled) setNotes(''); });
    return () => {
      cancelled = true;
      const p = pending.current;
      if (p) { clearTimeout(p.timer); saveNotes(sessionId, p.value); pending.current = null; }
    };
  }, [sessionId]);

  if (notes === null) return <p className={styles.muted}>Loading…</p>;

  return (
    <div className={styles.notesView}>
      <SessionNotesEditor
        value={notes}
        onChange={value => {
          setNotes(value);
          if (pending.current) clearTimeout(pending.current.timer);
          const timer = setTimeout(() => { pending.current = null; saveNotes(sessionId, value); }, SAVE_DELAY_MS);
          pending.current = { timer, value };
        }}
      />
    </div>
  );
}
