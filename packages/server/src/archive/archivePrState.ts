import { PrMetaCache } from '../git/prMetaCache.js';
import { parsePrUrl } from '../git/prRef.js';
import type { PrHistoryStore } from '../git/prHistoryStore.js';
import type { ArchiveEntry } from './archiveManager.js';

/** New PRs looked up per archive request. Known refs cost nothing; this only
 *  bounds the first open of a big archive (one `gh api` spawn per new PR). */
const MAX_NEW_LOOKUPS = 10;

const isTerminal = (state: string | undefined) => state === 'MERGED' || state === 'CLOSED';

/**
 * Archive entries keep the PR as it was when the session was archived —
 * usually OPEN. This overlays the current state: room PR history first (free),
 * then a REST lookup, cached with PrMetaCache's TTLs (24 h once merged/closed).
 * Its own cache instance: the snapshot one is pruned to live sessions' refs.
 * A history hit applies at once; a network lookup shows from the next request.
 */
export class ArchivePrState {
  private cache: PrMetaCache;
  private requested = new Set<string>();

  constructor(historyStore: PrHistoryStore) {
    this.cache = new PrMetaCache(() => {}, historyStore);
  }

  apply(entries: ArchiveEntry[]): ArchiveEntry[] {
    let budget = MAX_NEW_LOOKUPS;
    return entries.map(e => {
      const pr = e.pullRequest;
      // A stored MERGED/CLOSED never changes back.
      if (!pr || isTerminal(pr.state)) return e;
      const ref = parsePrUrl(pr.url);
      if (!ref) return e;
      if (!this.requested.has(ref)) {
        if (budget <= 0) return e;
        budget--;
        this.requested.add(ref);
      }
      // A room-history hit lands synchronously during the first get; read it back.
      const m = this.cache.get(ref, e.cwd) ?? this.cache.get(ref, e.cwd);
      if (!m?.state || (m.state === pr.state && (m.isDraft ?? pr.isDraft) === pr.isDraft)) return e;
      return { ...e, pullRequest: { ...pr, state: m.state, isDraft: m.isDraft ?? pr.isDraft } };
    });
  }
}
