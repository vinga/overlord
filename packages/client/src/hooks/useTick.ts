import { useState, useEffect } from 'react';

export function useTick(intervalMs: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
