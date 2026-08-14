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

describe('server sync', () => {
  it('hide/unhide with cwd POST /api/room-config', async () => {
    const { mod } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    mod.hideRoom('r1', '/repo/a');
    mod.unhideRoom('r1', '/repo/a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ cwd: '/repo/a', hidden: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ cwd: '/repo/a', hidden: false });
  });

  it('hide/unhide without cwd do not fetch', async () => {
    const { mod } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    mod.hideRoom('r1');
    mod.unhideRoom('r1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST failure keeps local state', async () => {
    const { mod } = await loadStore();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    mod.hideRoom('r1', '/repo/a');
    expect(mod.isRoomHidden('r1')).toBe(true);
  });

  it('unhideAll POSTs hidden:false for each hidden room with known cwd', async () => {
    const { mod } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    mod.hideRoom('r1');
    mod.hideRoom('r2');
    mod.unhideAll([{ id: 'r1', cwd: '/repo/a' }, { id: 'r2', cwd: '/repo/b' }, { id: 'r3', cwd: '/repo/c' }]);
    expect(mod.isRoomHidden('r1')).toBe(false);
    const bodies = fetchMock.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies).toEqual([
      { cwd: '/repo/a', hidden: false },
      { cwd: '/repo/b', hidden: false },
    ]);
  });

  it('seedFromServer union-merges hidden rooms once', async () => {
    const { mod, localStorage } = await loadStore({ [STORAGE_KEY]: JSON.stringify({ local: true }) });
    mod.seedFromServer([
      { id: 'srv', hidden: true },
      { id: 'visible' },
    ]);
    expect(mod.isRoomHidden('srv')).toBe(true);
    expect(mod.isRoomHidden('local')).toBe(true);
    expect(mod.isRoomHidden('visible')).toBe(false);
    // second seed is ignored — local unhide stays authoritative
    mod.unhideRoom('srv');
    mod.seedFromServer([{ id: 'srv', hidden: true }]);
    expect(mod.isRoomHidden('srv')).toBe(false);
    expect(JSON.parse(localStorage.store.get(STORAGE_KEY)!)).toEqual({ local: true });
  });

  it('seedFromServer seeds rooms that only appear in a later snapshot', async () => {
    const { mod } = await loadStore();
    // First snapshot after a server restart is partial — hydration still running.
    mod.seedFromServer([{ id: 'early', hidden: true }]);
    expect(mod.isRoomHidden('early')).toBe(true);
    // 'late' surfaces a few ticks later and must still get its persisted flag.
    mod.seedFromServer([{ id: 'early', hidden: true }, { id: 'late', hidden: true }]);
    expect(mod.isRoomHidden('late')).toBe(true);
  });

  it('seedFromServer does not re-hide a room unhidden after its first sighting', async () => {
    const { mod } = await loadStore();
    mod.seedFromServer([{ id: 'r1', hidden: true }]);
    mod.unhideRoom('r1');
    mod.seedFromServer([{ id: 'r1', hidden: true }, { id: 'new', hidden: true }]);
    expect(mod.isRoomHidden('r1')).toBe(false);
    expect(mod.isRoomHidden('new')).toBe(true);
  });

  it('an empty first snapshot does not consume seeding', async () => {
    const { mod } = await loadStore();
    mod.seedFromServer([]);
    mod.seedFromServer([{ id: 'r1', hidden: true }]);
    expect(mod.isRoomHidden('r1')).toBe(true);
  });
});
