import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// gh must never actually run here. The mock is callback-style on purpose:
// prMetaCache promisifies execFile, and resolving with a single `{ stdout }`
// object is what the promisified call destructures.
const gh = { title: 'from network', calls: 0, fail: false };
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    gh.calls++;
    if (gh.fail) { cb(new Error('timeout')); return; }
    cb(null, {
      stdout: JSON.stringify({
        html_url: 'https://github.com/exampleorg/demo-service/pull/732',
        title: gh.title,
        state: 'open',
        draft: false,
      }),
    });
  },
}));

const { PrMetaCache } = await import('../prMetaCache.js');
type PrHistoryStore = import('../prHistoryStore.js').PrHistoryStore;

const REF = 'exampleorg/demo-service#732';
const CWD = '/tmp/room';

/** Stub store carrying one entry matching REF. */
function historyStub(title: string): PrHistoryStore {
  return {
    list: () => [{
      url: 'https://github.com/exampleorg/demo-service/pull/732',
      title,
      state: 'OPEN',
      isDraft: false,
    }],
  } as unknown as PrHistoryStore;
}

/** Let the queued fetch promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PrMetaCache.invalidate', () => {
  beforeEach(() => { gh.title = 'from network'; gh.calls = 0; gh.fail = false; });

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

    cache.invalidate(['exampleorg/demo-service#746']);
    expect(cache.get(REF, CWD)?.title).toBe('kept');
    expect(gh.calls).toBe(0);
  });

  it('matches refs by normalized key, not raw string', async () => {
    const cache = new PrMetaCache(() => {}, historyStub('from history'));
    cache.get(REF, CWD);
    expect(cache.get(REF, CWD)?.title).toBe('from history');

    cache.invalidate(['EXAMPLEORG/Demo-Service#732']);
    expect(cache.get(REF, CWD)).toBeUndefined();
    await settle();
    expect(gh.calls).toBe(1);
  });
});

describe('PrMetaCache failed fetch', () => {
  beforeEach(() => { gh.title = 'from network'; gh.calls = 0; gh.fail = false; });
  afterEach(() => { vi.useRealTimers(); });

  it('retries a ref with nothing known after 2 minutes, not 30', async () => {
    const cache = new PrMetaCache(() => {});
    gh.fail = true;
    expect(cache.get(REF)).toBeUndefined();
    await settle();
    expect(gh.calls).toBe(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    cache.get(REF);
    expect(gh.calls).toBe(1);                 // still backing off

    gh.fail = false;
    vi.setSystemTime(Date.now() + 90_000);
    cache.get(REF);
    vi.useRealTimers();
    await settle();
    expect(gh.calls).toBe(2);
    expect(cache.get(REF)?.title).toBe('from network');
  });
});
