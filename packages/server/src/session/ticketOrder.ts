/** The user's ticket order for a session (↑/↓ in the context column). Pure helpers. */

export const TICKET_ORDER_MAX = 20;
const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** A stored ticketOrder, cleaned: strings shaped like Jira keys, deduped, capped. */
export function sanitizeTicketOrder(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const k of v) {
    if (typeof k === 'string' && TICKET_KEY_RE.test(k) && !out.includes(k)) out.push(k);
    if (out.length >= TICKET_ORDER_MAX) break;
  }
  return out.length ? out : undefined;
}

/** Stable reorder: keys found in `order` first, in that order; the rest keep
 *  their relative place. Never adds or drops a key. */
export function orderJiraKeys(keys: string[] | undefined, order: string[] | undefined): string[] | undefined {
  if (!keys?.length || !order?.length) return keys;
  const rank = new Map(order.map((k, i) => [k, i]));
  const ranked = keys.filter(k => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const rest = keys.filter(k => !rank.has(k));
  return [...ranked, ...rest];
}
