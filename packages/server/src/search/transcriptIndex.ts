import { Worker } from 'worker_threads';
import type { ConversationSource } from './transcriptIndexWorker.js';

export type { ConversationSource };

type Result = Record<string, ConversationSource[]>;
interface Waiter { resolve: (r: Result | null) => void; reject: (e: Error) => void }

/** The first search builds the whole index; later ones only read appended bytes. */
const TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let seq = 0;
let inFlight: { id: number; waiter: Waiter; timer: ReturnType<typeof setTimeout> } | null = null;
/** At most one queued request: a newer query replaces an older queued one. */
let queued: { q: string; paths: string[]; waiter: Waiter } | null = null;

const IS_TS = import.meta.url.endsWith('.ts');

function createWorker(): Worker {
  // Dev runs the .ts source (self-contained, so Node strips its types without
  // tsx); the build runs the compiled .js next to this file.
  return new Worker(new URL(`./transcriptIndexWorker.${IS_TS ? 'ts' : 'js'}`, import.meta.url));
}

function failAll(err: Error): void {
  if (inFlight) { clearTimeout(inFlight.timer); inFlight.waiter.reject(err); inFlight = null; }
  if (queued) { queued.waiter.reject(err); queued = null; }
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = createWorker();
  w.unref();
  w.on('message', (msg: { id: number; result?: Result; error?: string }) => {
    if (!inFlight || msg.id !== inFlight.id) return;
    const { waiter, timer } = inFlight;
    clearTimeout(timer);
    inFlight = null;
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.result ?? {});
    pump();
  });
  const reset = (err: Error) => {
    console.warn('[search-index] worker stopped:', err.message);
    if (worker === w) worker = null;
    failAll(err);
  };
  w.on('error', reset);
  w.on('exit', code => { if (code !== 0) reset(new Error(`exit ${code}`)); else if (worker === w) worker = null; });
  worker = w;
  return w;
}

function pump(): void {
  if (inFlight || !queued) return;
  const { q, paths, waiter } = queued;
  queued = null;
  const id = ++seq;
  const timer = setTimeout(() => {
    if (inFlight?.id !== id) return;
    inFlight = null;
    waiter.reject(new Error('search timed out'));
    pump();
  }, TIMEOUT_MS);
  inFlight = { id, waiter, timer };
  getWorker().postMessage({ id, q, paths });
}

/**
 * Which of `paths` contain `q` in user, agent or tool-call text. Resolves
 * null when a newer query superseded this one before it ran.
 */
export function searchTranscripts(q: string, paths: string[]): Promise<Result | null> {
  return new Promise((resolve, reject) => {
    if (queued) queued.waiter.resolve(null);
    queued = { q, paths, waiter: { resolve, reject } };
    pump();
  });
}
