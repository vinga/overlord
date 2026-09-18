import { describe, it, expect, vi, beforeEach } from 'vitest';

// gh must never actually run here. The mock is callback-style on purpose:
// prMetaCache promisifies execFile, and resolving with a single `{ stdout }`
// object is what the promisified call destructures.
const gh = { title: 'from network', calls: 0 };
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: unknown) => void) => {
    gh.calls++;
    cb(null, {
      stdout: JSON.stringify({
        html_url: 'https://github.com/hypatos/prompting-service/pull/732',
        title: gh.title,
        state: 'open',
        draft: false,
      }),
    });
  },
}));

const { PrMetaCache } = await import('../prMetaCache.js');
type PrHistoryStore = import('../prHistoryStore.js').PrHistoryStore;

const REF = 'hypatos/prompting-service#732';
const CWD = '/tmp/room';

/** Stub store carrying one entry matching REF. */
function historyStub(title: string): PrHistoryStore {
  return {
    list: () => [{
      url: 'https://github.com/hypatos/prompting-service/pull/732',
      title,
      state: 'OPEN',
      isDraft: false,
    }],
  } as unknown as PrHistoryStore;
}

/** Let the queued fetch promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PrMetaCache.invalidate', () => {
  beforeEach(() => { gh.title = 'from network'; gh.calls = 0; });

  it('drops the entry and forces a GitHub read past the history shortcut', async () => {
    const cache = new PrMetaCache(() => {}, historyStub('from history'));

    expect(cache.get(REF, CWD)).toBeUndefined();            // miss → schedules
    expect(cache.get(REF, CWD)?.title).toBe('from history'); // free path, no network
    expect(gh.calls).toBe(0);

    // Without invalidation the 15-min OPEN TTL keeps serving that value.
    expect(cache.get(REF, CWD)?.title).toBe('from history');
    expect(gh.calls).toBe(0);

    gh.title = 'fresh from github';
    cache.invalidate([REF]);
    expect(cache.get(REF, CWD)).toBeUndefined();            // entry gone
    await settle();
    expect(cache.get(REF, CWD)?.title).toBe('fresh from github');
    expect(gh.calls).toBe(1);
  });

  it('leaves other refs alone', () => {
    const cache = new PrMetaCache(() => {}, historyStub('kept'));
    cache.get(REF, CWD);
    expect(cache.get(REF, CWD)?.title).toBe('kept');

    cache.invalidate(['hypatos/prompting-service#746']);
    expect(cache.get(REF, CWD)?.title).toBe('kept');
    expect(gh.calls).toBe(0);
  });

  it('matches refs by normalized key, not raw string', async () => {
    const cache = new PrMetaCache(() => {}, historyStub('from history'));
    cache.get(REF, CWD);
    expect(cache.get(REF, CWD)?.title).toBe('from history');

    cache.invalidate(['HYPATOS/Prompting-Service#732']);
    expect(cache.get(REF, CWD)).toBeUndefined();
    await settle();
    expect(gh.calls).toBe(1);
  });
});
