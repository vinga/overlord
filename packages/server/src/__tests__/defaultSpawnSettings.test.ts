import { describe, expect, it } from 'vitest';
import { sanitize } from '../session/globalSettingsStore.js';

// Pure validation only — no patch(), so the real settings.json is never written.

describe('default provider / mode settings', () => {
  it('keeps known providers and modes', () => {
    expect(sanitize({ defaultProvider: 'codex', defaultMode: 'embedded' }))
      .toEqual({ defaultProvider: 'codex', defaultMode: 'embedded' });
    expect(sanitize({ defaultProvider: 'claude', defaultMode: 'bridge' }))
      .toEqual({ defaultProvider: 'claude', defaultMode: 'bridge' });
  });

  it('drops unknown values instead of coercing', () => {
    const bad = { defaultProvider: 'aider', defaultMode: 'raw' } as unknown as Parameters<typeof sanitize>[0];
    expect(sanitize(bad)).toEqual({});
  });
});
