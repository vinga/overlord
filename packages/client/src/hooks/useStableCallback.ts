import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Stable-identity wrapper around a callback that always calls the latest `fn`.
 * Lets a parent pass plain (re-created every render) handlers down to `memo`'d
 * children without breaking their prop equality. `undefined` in → `undefined` out,
 * so optional-handler checks (`onRename ? … : …`) keep working.
 */
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T;
export function useStableCallback<T extends (...args: any[]) => any>(fn: T | undefined): T | undefined;
export function useStableCallback<T extends (...args: any[]) => any>(fn: T | undefined): T | undefined {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  const stable = useCallback((...args: Parameters<T>) => ref.current?.(...args), []) as T;
  return fn ? stable : undefined;
}
