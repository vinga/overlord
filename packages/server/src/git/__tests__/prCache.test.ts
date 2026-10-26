import { describe, it, expect, vi, beforeEach } from 'vitest';

// git + gh must never actually run here. Callback-style mock: prCache
// promisifies execFile and destructures `{ stdout }`.
const gh = { calls: [] as string[] };
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: null, r: unknown) => void) => {
    if (cmd === 'git') {
      cb(null, { stdout: 'git@github.com:exampleorg/demo-service.git\n' });
      return;
    }
    const head = args[args.indexOf('-f') + 1]; // head=exampleorg:<branch>
    const branch = head.split(':')[1];
    gh.calls.push(branch);
    cb(null, {
      stdout: JSON.stringify([{
        number: 502,
        html_url: 'https://github.com/exampleorg/demo-service/pull/502',
        title: 'old branch PR',
        state: 'closed',
        draft: false,
        merged_at: '2026-09-07T14:02:50Z',
      }]),
    });
  },
}));

const { PrCache } = await import('../prCache.js');
type PrHistoryStore = import('../prHistoryStore.js').PrHistoryStore;

const CWD = '/tmp/room';

function historyStub(entries: Array<{ number: number; state: string; branch: string }>) {
  const recorded: Array<{ branch: string; state: string }> = [];
  const store = {
    list: () => entries,
    record: (_cwd: string, branch: string, pr: { state: string }) => { recorded.push({ branch, state: pr.state }); },
  } as unknown as PrHistoryStore;
  return { store, recorded };
}

describe('PrCache.refreshHistory', () => {
  beforeEach(() => { gh.calls = []; });

  it('re-fetches non-merged history branches and records the fresh state', async () => {
    const { store, recorded } = historyStub([
      { number: 551, state: 'MERGED', branch: 'current' },
      { number: 502, state: 'OPEN', branch: 'old-branch' },
    ]);
    const cache = new PrCache(() => {}, store);

    await cache.refreshHistory(CWD);

    expect(gh.calls).toEqual(['old-branch']);
    expect(recorded).toEqual([{ branch: 'old-branch', state: 'MERGED' }]);
  });

  it('does not re-fetch a branch fetched moments ago', async () => {
    const { store } = historyStub([{ number: 502, state: 'OPEN', branch: 'old-branch' }]);
    const cache = new PrCache(() => {}, store);

    await cache.refreshHistory(CWD);
    await cache.refreshHistory(CWD);

    expect(gh.calls).toEqual(['old-branch']);
  });
});
