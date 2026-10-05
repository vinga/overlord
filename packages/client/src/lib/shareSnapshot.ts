/**
 * Structural sharing for WebSocket snapshots.
 *
 * The server pushes a full snapshot every ~1.5s and `JSON.parse` hands back brand
 * new objects each time, so every `memo`'d Room / WorkerGroup / Worker misses and
 * the whole grid re-renders on every tick. This walks `next` against `prev` and
 * reuses the `prev` reference for every subtree whose content is unchanged — an
 * idle worker keeps its exact object identity across ticks.
 *
 * Plain objects and arrays only (JSON output); anything else compares by `Object.is`.
 */
export function shareSnapshot<T>(prev: T, next: T): T {
  return share(prev, next) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;

  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      out[i] = i < prev.length ? share(prev[i], next[i]) : next[i];
      if (out[i] !== prev[i]) same = false;
    }
    return same ? prev : out;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const value = Object.prototype.hasOwnProperty.call(prev, key) ? share(prev[key], next[key]) : next[key];
      out[key] = value;
      if (same && (value !== prev[key] || !Object.prototype.hasOwnProperty.call(prev, key))) same = false;
    }
    return same ? prev : out;
  }

  return next;
}
