import { useEffect, useState } from 'react';

// Shared across card remounts so a room re-render doesn't refetch every note.
const cache = new Map<string, { version: string; content: string }>();

/**
 * Raw markdown of a notepad session, for rendering on its desk card. The
 * snapshot only carries a plain-text preview (`lastMessage`), so the card
 * fetches the file and refetches whenever `version` (lastActivity) moves.
 * Returns undefined until the first load — callers fall back to the preview.
 */
export function useNoteMarkdown(noteId: string | undefined, version: string | undefined): string | undefined {
  const cached = noteId ? cache.get(noteId) : undefined;
  const [content, setContent] = useState<string | undefined>(cached?.content);

  useEffect(() => {
    if (!noteId) return;
    const hit = cache.get(noteId);
    if (hit) setContent(hit.content);
    if (hit && hit.version === (version ?? '')) return;
    let cancelled = false;
    fetch(`/api/notes/${encodeURIComponent(noteId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then((data: { content?: string } | null) => {
        if (cancelled || typeof data?.content !== 'string') return;
        cache.set(noteId, { version: version ?? '', content: data.content });
        setContent(data.content);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [noteId, version]);

  return noteId ? content : undefined;
}
