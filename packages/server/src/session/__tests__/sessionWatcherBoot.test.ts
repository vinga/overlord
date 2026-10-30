import { describe, it, expect } from 'vitest';
import { startedBeforeBoot } from '../sessionWatcher.js';

describe('startedBeforeBoot', () => {
  const now = 1_800_000_000_000;
  const uptimeSec = 600; // booted 10 min ago

  it('flags a pid file written before the reboot', () => {
    expect(startedBeforeBoot({ startedAt: now - 3_600_000 }, now, uptimeSec)).toBe(true);
  });

  it('keeps a session started after boot', () => {
    expect(startedBeforeBoot({ startedAt: now - 60_000 }, now, uptimeSec)).toBe(false);
  });

  it('keeps a session with no startedAt', () => {
    expect(startedBeforeBoot({ startedAt: undefined as unknown as number }, now, uptimeSec)).toBe(false);
  });
});
