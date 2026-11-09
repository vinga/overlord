import { describe, it, expect } from 'vitest';
import { orderJiraKeys, sanitizeTicketOrder, TICKET_ORDER_MAX } from '../session/ticketOrder.js';

describe('orderJiraKeys', () => {
  it('puts ordered keys first, in order; the rest keep their place', () => {
    expect(orderJiraKeys(['A-1', 'B-2', 'C-3', 'D-4'], ['C-3', 'A-1'])).toEqual(['C-3', 'A-1', 'B-2', 'D-4']);
  });

  it('never adds or drops keys; unknown order entries are ignored', () => {
    expect(orderJiraKeys(['A-1', 'B-2'], ['Z-9', 'B-2'])).toEqual(['B-2', 'A-1']);
  });

  it('returns the input when there is nothing to order', () => {
    const keys = ['A-1'];
    expect(orderJiraKeys(keys, undefined)).toBe(keys);
    expect(orderJiraKeys(undefined, ['A-1'])).toBeUndefined();
  });
});

describe('sanitizeTicketOrder', () => {
  it('keeps Jira-shaped strings, deduped', () => {
    expect(sanitizeTicketOrder(['A-1', 'A-1', 'bad', 3, 'B-2'])).toEqual(['A-1', 'B-2']);
  });

  it('caps the list and rejects non-arrays', () => {
    const many = Array.from({ length: TICKET_ORDER_MAX + 5 }, (_, i) => `K-${i}`);
    expect(sanitizeTicketOrder(many)).toHaveLength(TICKET_ORDER_MAX);
    expect(sanitizeTicketOrder('A-1')).toBeUndefined();
    expect(sanitizeTicketOrder([])).toBeUndefined();
  });
});
