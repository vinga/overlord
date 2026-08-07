import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'overlord:roomHidden';

function makeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

async function loadStore(initial: Record<string, string> = {}) {
  vi.resetModules();
  const localStorage = makeLocalStorage(initial);
  vi.stubGlobal('localStorage', localStorage);
  const mod = await import('../useRoomHidden');
  return { mod, localStorage };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useRoomHidden store', () => {
  it('starts empty and hides a room', async () => {
    const { mod, localStorage } = await loadStore();
    expect(mod.isRoomHidden('r1')).toBe(false);
    mod.hideRoom('r1');
    expect(mod.isRoomHidden('r1')).toBe(true);
    expect(JSON.parse(localStorage.store.get(STORAGE_KEY)!)).toEqual({ r1: true });
  });

  it('unhide removes the key entirely', async () => {
    const { mod, localStorage } = await loadStore();
    mod.hideRoom('r1');
    mod.unhideRoom('r1');
    expect(mod.isRoomHidden('r1')).toBe(false);
    expect(JSON.parse(localStorage.store.get(STORAGE_KEY)!)).toEqual({});
  });

  it('unhide of a visible room is a no-op write', async () => {
    const { mod, localStorage } = await loadStore();
    mod.unhideRoom('never-hidden');
    expect(localStorage.store.has(STORAGE_KEY)).toBe(false);
  });

  it('hide of an already-hidden room is a no-op write', async () => {
    const { mod, localStorage } = await loadStore();
    mod.hideRoom('r1');
    const raw = localStorage.store.get(STORAGE_KEY);
    mod.hideRoom('r1');
    expect(localStorage.store.get(STORAGE_KEY)).toBe(raw);
  });

  it('unhideAll clears every room', async () => {
    const { mod, localStorage } = await loadStore();
    mod.hideRoom('r1');
    mod.hideRoom('r2');
    mod.unhideAll();
    expect(mod.isRoomHidden('r1')).toBe(false);
    expect(mod.isRoomHidden('r2')).toBe(false);
    expect(JSON.parse(localStorage.store.get(STORAGE_KEY)!)).toEqual({});
  });

  it('hydrates from persisted storage', async () => {
    const { mod } = await loadStore({ [STORAGE_KEY]: JSON.stringify({ r7: true }) });
    expect(mod.isRoomHidden('r7')).toBe(true);
    expect(mod.isRoomHidden('r8')).toBe(false);
  });

  it('survives corrupted storage', async () => {
    const { mod } = await loadStore({ [STORAGE_KEY]: 'not-json{' });
    expect(mod.isRoomHidden('r1')).toBe(false);
    mod.hideRoom('r1');
    expect(mod.isRoomHidden('r1')).toBe(true);
  });
});
