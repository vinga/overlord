import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../formatElapsed';

describe('formatElapsed', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  it('renders seconds, minutes, hours', () => {
    expect(formatElapsed('2026-07-27T11:59:30.000Z', now)).toBe('30s');
    expect(formatElapsed('2026-07-27T11:55:00.000Z', now)).toBe('5m');
    expect(formatElapsed('2026-07-27T09:00:00.000Z', now)).toBe('3h');
    expect(formatElapsed('2026-07-27T08:30:00.000Z', now)).toBe('3h 30m');
  });
  it('renders nothing for a missing or unparseable timestamp', () => {
    expect(formatElapsed(undefined, now)).toBe('');
    expect(formatElapsed('not-a-date', now)).toBe('');
  });
  it('clamps a future start to 0s rather than going negative', () => {
    expect(formatElapsed('2026-07-27T12:00:30.000Z', now)).toBe('0s');
  });
});
