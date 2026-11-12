import { useEffect, useState } from 'react';
import type { ConversationSource } from '../lib/searchSources';

const DEBOUNCE_MS = 300;

export interface ConversationMatches {
  /** sessionId → where the query appears in its conversation. */
  sources: Record<string, ConversationSource[]>;
  /** A request for the current query is in flight (the first one after a server start can take a while). */
  pending: boolean;
}

const EMPTY: ConversationMatches = { sources: {}, pending: false };

/** Debounced server search of conversation text (user, agent, tool calls). */
export function useConversationMatches(query: string): ConversationMatches {
  const q = query.trim();
  const [state, setState] = useState<{ q: string; result: ConversationMatches }>({ q: '', result: EMPTY });

  useEffect(() => {
    if (q.length < 2) { setState({ q: '', result: EMPTY }); return; }
    setState(prev => ({ q, result: { sources: prev.q === q ? prev.result.sources : {}, pending: true } }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search/sources?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then(r => (r.ok ? r.json() : { sources: {} }) as Promise<{ sources?: Record<string, ConversationSource[]>; superseded?: boolean }>)
        .then(data => {
          if (data.superseded) return; // a newer query owns the state
          setState({ q, result: { sources: data.sources ?? {}, pending: false } });
        })
        .catch(err => {
          if ((err as Error).name === 'AbortError') return;
          setState({ q, result: { sources: {}, pending: false } });
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);

  return state.q === q ? state.result : (q.length >= 2 ? { sources: {}, pending: true } : EMPTY);
}
