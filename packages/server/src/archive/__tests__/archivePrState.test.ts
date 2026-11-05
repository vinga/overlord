import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string }) => void) =>
    cb(new Error('no network in tests')),
}));

import { ArchivePrState } from '../archivePrState.js';
import type { PrHistoryStore } from '../../git/prHistoryStore.js';
import type { ArchiveEntry } from '../archiveManager.js';

const URL = 'https://github.com/acme/app/pull/505';

function historyWith(state: string): PrHistoryStore {
  return {
    list: () => [{ number: 505, url: URL, title: 'T', state, isDraft: false, branch: 'b', firstSeenAt: 0, lastSeenAt: 0 }],
  } as unknown as PrHistoryStore;
}

function entry(state: string, url = URL): ArchiveEntry {
  return {
    sessionId: 's', overlordId: 'o', roomId: 'r', cwd: '/repo', name: 'n', archivedAt: '', transcriptPath: '',
    transcripts: [], pid: 0,
    pullRequest: { number: 505, url, title: 'T', state, isDraft: false },
  };
}

describe('ArchivePrState', () => {
  it('shows the current state from room history on the first request', () => {
    const out = new ArchivePrState(historyWith('MERGED')).apply([entry('OPEN')]);
    expect(out[0].pullRequest?.state).toBe('MERGED');
  });

  it('leaves a stored MERGED/CLOSED entry alone', () => {
    const e = entry('CLOSED');
    expect(new ArchivePrState(historyWith('OPEN')).apply([e])[0]).toBe(e);
  });

  it('returns the same entry when nothing changed', () => {
    const e = entry('OPEN');
    expect(new ArchivePrState(historyWith('OPEN')).apply([e])[0]).toBe(e);
  });

  it('caps new lookups per request', () => {
    const store = { list: vi.fn(() => []) } as unknown as PrHistoryStore;
    const entries = Array.from({ length: 15 }, (_, i) => entry('OPEN', `https://github.com/acme/app/pull/${i + 1}`));
    new ArchivePrState(store).apply(entries);
    expect((store.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(10);
  });
});
