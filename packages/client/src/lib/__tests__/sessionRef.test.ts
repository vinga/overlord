import { describe, expect, it } from 'vitest';
import { formatSessionRef, sessionDisplayName } from '../sessionRef';

describe('formatSessionRef', () => {
  it('labels both IDs and quotes the name', () => {
    expect(formatSessionRef({
      name: 'Labradorite',
      sessionId: '2ea7769f-b904-4e5b-9fc3-4fe8bf6c7991',
      overlordId: 'ovr-jqcz621b',
    })).toBe('Overlord session "Labradorite" — overlordId: ovr-jqcz621b · claude sessionId: 2ea7769f-b904-4e5b-9fc3-4fe8bf6c7991');
  });

  it('omits overlordId when absent', () => {
    expect(formatSessionRef({ name: 'x', sessionId: 'abc' }))
      .toBe('Overlord session "x" — claude sessionId: abc');
  });

  it('escapes quotes inside the name', () => {
    expect(formatSessionRef({ name: 'say "hi"', sessionId: 'abc' }))
      .toContain('"say \\"hi\\""');
  });
});

describe('sessionDisplayName', () => {
  const base = { sessionId: '2ea7769f-b904-4e5b-9fc3-4fe8bf6c7991' };
  it('prefers custom name, then proposed, then slug, then short id', () => {
    expect(sessionDisplayName({ ...base, proposedName: 'P', slug: 'S' }, 'C')).toBe('C');
    expect(sessionDisplayName({ ...base, proposedName: 'P', slug: 'S' })).toBe('P');
    expect(sessionDisplayName({ ...base, slug: 'S' })).toBe('S');
    expect(sessionDisplayName(base)).toBe('2ea7769f');
  });
});
