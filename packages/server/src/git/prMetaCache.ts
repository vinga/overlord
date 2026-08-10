import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrRefMeta } from '../types.js';
import type { PrHistoryStore } from './prHistoryStore.js';
import { parsePrUrl, prRefKey, splitPrRef } from './prRef.js';

const execFileAsync = promisify(execFile);

const OPEN_TTL_MS = 15 * 60 * 1000;       // an open PR can change title/state
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000; // MERGED/CLOSED never change
const ERROR_TTL_MS = 30 * 60 * 1000;      // back off on failure / rate limit

interface Entry {
  value: PrRefMeta | undefined;
  fetchedAt: number;
  error: boolean;
  inFlight?: Promise<void>;
}

function isTerminal(state: string | undefined): boolean {
  return state === 'MERGED' || state === 'CLOSED';
}

/**
 * Title/state for `owner/repo#number` refs attached to sessions.
 *
 * Resolution order is deliberately cheap-first: most refs belong to a room's own
 * branch and are already on disk in `<room>.pr-history.json` with title + state,
 * costing nothing. Only refs absent from history hit the network, once, via REST
 * (gh's `core` quota pool — GraphQL is reserved for `gh pr create` and friends).
 */
export class PrMetaCache {
  private entries = new Map<string, Entry>();
  private onUpdate: () => void;
  private historyStore: PrHistoryStore | undefined;

  constructor(onUpdate: () => void, historyStore?: PrHistoryStore) {
    this.onUpdate = onUpdate;
    this.historyStore = historyStore;
  }

  /** Synchronous read for snapshot assembly. Schedules a refresh when stale or
   *  missing and returns whatever is known meanwhile (possibly undefined). */
  get(ref: string, cwdHint?: string): PrRefMeta | undefined {
    const key = prRefKey(ref);
    const entry = this.entries.get(key);
    if (!entry) {
      this.scheduleRefresh(ref, cwdHint);
      return undefined;
    }
    const ttl = entry.error
      ? ERROR_TTL_MS
      : isTerminal(entry.value?.state) ? TERMINAL_TTL_MS : OPEN_TTL_MS;
    if (Date.now() - entry.fetchedAt > ttl) this.scheduleRefresh(ref, cwdHint);
    return entry.value;
  }

  /** Drop everything no longer attached to a session. */
  retain(refs: Set<string>): void {
    const keep = new Set<string>();
    for (const r of refs) keep.add(prRefKey(r));
    for (const key of this.entries.keys()) {
      if (!keep.has(key)) this.entries.delete(key);
    }
  }

  private scheduleRefresh(ref: string, cwdHint?: string): void {
    const key = prRefKey(ref);
    const existing = this.entries.get(key);
    if (existing?.inFlight) return;

    const placeholder: Entry = {
      value: existing?.value,
      fetchedAt: existing?.fetchedAt ?? 0,
      error: existing?.error ?? false,
    };
    this.entries.set(key, placeholder);

    // Free path first: the room's PR history already carries title + state for
    // any PR the branch poller has seen.
    const fromHistory = this.lookupHistory(ref, cwdHint);
    if (fromHistory) {
      this.entries.set(key, { value: fromHistory, fetchedAt: Date.now(), error: false });
      this.onUpdate();
      return;
    }

    placeholder.inFlight = fetchPrMeta(ref, cwdHint)
      .then(value => {
        this.entries.set(key, { value: value ?? placeholder.value, fetchedAt: Date.now(), error: !value });
        this.onUpdate();
      })
      .catch(() => {
        this.entries.set(key, { value: placeholder.value, fetchedAt: Date.now(), error: true });
      });
  }

  private lookupHistory(ref: string, cwdHint?: string): PrRefMeta | undefined {
    if (!this.historyStore || !cwdHint) return undefined;
    const key = prRefKey(ref);
    for (const entry of this.historyStore.list(cwdHint)) {
      // Match on the full ref, not the bare number — two rooms in different
      // repos routinely both have a #12.
      if (prRefKey(parsePrUrl(entry.url) ?? '') !== key) continue;
      return {
        title: entry.title,
        state: entry.state,
        isDraft: entry.isDraft,
        url: entry.url,
      };
    }
    return undefined;
  }
}

interface RestPull {
  html_url?: string;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
}

async function fetchPrMeta(ref: string, cwd?: string): Promise<PrRefMeta | undefined> {
  const parts = splitPrRef(ref);
  if (!parts) return undefined;
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      '-X', 'GET',
      '-H', 'Accept: application/vnd.github+json',
      `/repos/${parts.owner}/${parts.repo}/pulls/${parts.number}`,
    ],
    { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }
  );
  const p = JSON.parse(stdout) as RestPull;
  if (!p || typeof p !== 'object') return undefined;
  let state = (p.state ?? '').toUpperCase();
  if (state === 'CLOSED' && p.merged_at) state = 'MERGED';
  return {
    title: p.title,
    state: state || undefined,
    isDraft: !!p.draft,
    url: p.html_url,
  };
}
