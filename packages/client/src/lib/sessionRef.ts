import type { Session } from '../types';

export interface SessionRefInput {
  name: string;
  sessionId: string;
  overlordId?: string;
}

/**
 * Human- and agent-readable identity line for a session, e.g.
 *
 *   Overlord session "Labradorite" — overlordId: ovr-jqcz621b · claude sessionId: 2ea7769f-…
 *
 * Leads with "Overlord session" so a pasted line is self-describing, quotes the
 * name so multi-word names stay unambiguous, and labels each ID the way the
 * REST API and the `overlord-sessions` skill name them (`overlordId` for the
 * stable ovr-XXXX record, `sessionId` for the live Claude UUID).
 */
export function formatSessionRef({ name, sessionId, overlordId }: SessionRefInput): string {
  const quoted = JSON.stringify(name);
  const ids = [
    overlordId ? `overlordId: ${overlordId}` : undefined,
    `claude sessionId: ${sessionId}`,
  ].filter(Boolean);
  return `Overlord session ${quoted} — ${ids.join(' · ')}`;
}

/** Display-name fallback chain shared by the detail panel header and the desk card. */
export function sessionDisplayName(session: Pick<Session, 'sessionId' | 'proposedName' | 'slug'>, customName?: string): string {
  return customName ?? session.proposedName ?? session.slug ?? session.sessionId.slice(0, 8);
}
