import { useState, useEffect } from 'react';

let notesMap: Map<string, string> = new Map();
/** Full notes text per session — search matches anywhere in it, not only the first line. */
const notesText: Map<string, string> = new Map();
let fetched = false;
let listeners: Set<() => void> = new Set();

function notify() {
  listeners.forEach(l => l());
}

function extractFirstLine(content: string): string {
  const raw = content.split('\n').find(l => l.trim()) ?? '';
  // Strip common markdown symbols: #, *, -, >, `, ~, _
  return raw.replace(/^[#>*\-_`~\s]+/, '').trim();
}

/** The session's full notes, as last fetched or saved in this tab. */
export function getNoteText(sessionId: string): string | undefined {
  return notesText.get(sessionId);
}

export function updateNoteFirstLine(sessionId: string, content: string): void {
  if (content.trim()) notesText.set(sessionId, content); else notesText.delete(sessionId);
  const firstLine = extractFirstLine(content);
  if (firstLine) {
    notesMap.set(sessionId, firstLine);
  } else {
    notesMap.delete(sessionId);
  }
  notify();
}

export function useNotesSummaries(): Map<string, string> {
  const [, rerender] = useState(0);

  useEffect(() => {
    const listener = () => rerender(n => n + 1);
    listeners.add(listener);

    if (!fetched) {
      fetched = true;
      fetch('/api/notes')
        .then(r => r.json())
        .then((data: Record<string, string>) => {
          for (const [id, content] of Object.entries(data)) {
            if (content.trim()) notesText.set(id, content);
            const firstLine = extractFirstLine(content);
            if (firstLine) notesMap.set(id, firstLine);
          }
          notify();
        })
        .catch(() => {});
    }

    return () => { listeners.delete(listener); };
  }, []);

  return notesMap;
}
