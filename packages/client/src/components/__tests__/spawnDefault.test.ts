import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSpawnDefault, normalizeSpawnDefault, resolveQuickSpawn, saveSpawnDefault, setSpawnDefault } from '../quickSpawn';

afterEach(() => {
  setSpawnDefault('claude', 'embedded');
  vi.unstubAllGlobals();
});

describe('normalizeSpawnDefault', () => {
  it('defaults to claude / embedded', () => {
    expect(normalizeSpawnDefault(undefined, undefined)).toEqual({ provider: 'claude', mode: 'embedded' });
  });
  it('keeps a claude external mode', () => {
    expect(normalizeSpawnDefault('claude', 'bridge')).toEqual({ provider: 'claude', mode: 'bridge' });
  });
  it('forces embedded for codex and opencode', () => {
    expect(normalizeSpawnDefault('codex', 'plain')).toEqual({ provider: 'codex', mode: 'embedded' });
    expect(normalizeSpawnDefault('opencode', 'bridge')).toEqual({ provider: 'opencode', mode: 'embedded' });
  });
  it('rejects unknown values', () => {
    expect(normalizeSpawnDefault('aider', 'raw')).toEqual({ provider: 'claude', mode: 'embedded' });
  });
});

describe('quick spawn uses the global default', () => {
  it('ignores room-config lastProvider / lastMode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ prefix: '', lastProvider: 'claude', lastMode: 'bridge' }) })));
    setSpawnDefault('codex', 'embedded');
    const choice = await resolveQuickSpawn('/project');
    expect(choice.provider).toBe('codex');
    expect(choice.mode).toBe('embedded');
  });
});

describe('saveSpawnDefault', () => {
  it('PATCHes /api/settings and applies locally', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await saveSpawnDefault('codex', 'bridge')).toBe(true);
    expect(getSpawnDefault()).toEqual({ provider: 'codex', mode: 'embedded' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings');
    expect(JSON.parse(init.body as string)).toEqual({ defaultProvider: 'codex', defaultMode: 'embedded' });
  });
  it('reverts when the save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await saveSpawnDefault('opencode', 'embedded')).toBe(false);
    expect(getSpawnDefault()).toEqual({ provider: 'claude', mode: 'embedded' });
  });
});
