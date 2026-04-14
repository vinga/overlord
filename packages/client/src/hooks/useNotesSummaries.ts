import { useState, useEffect } from 'react';

let notesMap: Map<string, string> = new Map();
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

export function updateNoteFirstLine(sessionId: string, content: string): void {
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
