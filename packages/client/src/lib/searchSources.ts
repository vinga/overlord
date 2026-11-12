import type { Room, Session } from '../types';

/** Where a search query matched in a session. */
export type SearchSource = 'you' | 'agent' | 'tool' | 'ticket' | 'pr' | 'pin' | 'notes' | 'subagent';
/** Conversation sources come from the server's transcript index. */
export type ConversationSource = Extract<SearchSource, 'you' | 'agent' | 'tool'>;

export const SOURCE_ORDER: readonly SearchSource[] = ['you', 'agent', 'tool', 'ticket', 'pr', 'pin', 'notes', 'subagent'];

export const SOURCE_LABEL: Record<SearchSource, string> = {
  you: 'You',
  agent: 'Agent',
  tool: 'Tool',
  ticket: 'Ticket',
  pr: 'PR',
  pin: 'Pin',
  notes: 'Notes',
  subagent: 'Subagent',
};

interface JiraMetaLite { title?: string; type?: string; status?: string }

export interface MetadataContext {
  jiraMeta?: Record<string, JiraMetaLite | undefined>;
  noteText?: (sessionId: string) => string | undefined;
}

const has = (q: string, ...fields: (string | undefined | null)[]) =>
  fields.some(f => typeof f === 'string' && f.toLowerCase().includes(q));

/** Sources found in the session's own data (no conversation text). `q` is lowercased. */
export function metadataSources(session: Session, room: Room | null | undefined, q: string, ctx: MetadataContext): SearchSource[] {
  const out: SearchSource[] = [];
  if ((session.jiraKeys ?? []).some(k => {
    const m = ctx.jiraMeta?.[k];
    return has(q, k, m?.title, m?.type, m?.status);
  })) out.push('ticket');
  if ((session.prRefs ?? []).some(r => has(q, r))) out.push('pr');
  if ([...(session.pins ?? []), ...(room?.pins ?? [])].some(p => has(q, p.title, p.url, p.text))) out.push('pin');
  if (has(q, ctx.noteText?.(session.sessionId))) out.push('notes');
  if ((session.subagents ?? []).some(a => has(q, a.agentType, a.description, a.lastActivity))) out.push('subagent');
  return out;
}

/** Conversation + metadata sources, de-duplicated, in display order. */
export function mergeSources(a: readonly SearchSource[], b: readonly SearchSource[]): SearchSource[] {
  const set = new Set([...a, ...b]);
  return SOURCE_ORDER.filter(s => set.has(s));
}
