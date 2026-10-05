import { useRef } from 'react';
import { shareSnapshot } from '../lib/shareSnapshot';

/**
 * Returns the previous reference while `value` is deep-equal to it. For derived
 * objects recomputed on every snapshot (e.g. a name map) that are passed to
 * `memo`'d children.
 */
export function useSharedValue<T>(value: T): T {
  const ref = useRef(value);
  ref.current = shareSnapshot(ref.current, value);
  return ref.current;
}
