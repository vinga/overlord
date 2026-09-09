import { useCallback, useEffect, useState } from 'react';

export type Orientation = 'portrait' | 'landscape';
export type DockMode = 'auto' | 'right' | 'bottom';
export type Dock = 'right' | 'bottom';

const DOCK_KEY = 'overlord:panelDock';
const DOCK_EVENT = 'overlord:dockModeChanged';

/** Live viewport orientation via matchMedia. */
export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(() =>
    window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'
  );

  useEffect(() => {
    const mql = window.matchMedia('(orientation: portrait)');
    const onChange = (e: MediaQueryListEvent) => setOrientation(e.matches ? 'portrait' : 'landscape');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return orientation;
}

function readDockMode(): DockMode {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    if (v === 'right' || v === 'bottom' || v === 'auto') return v;
  } catch { /* storage unavailable */ }
  return 'auto';
}

/**
 * Per-browser dock preference (`auto` follows orientation). Synced across
 * hook instances (App + SettingsModal) via a custom event, not prop drilling.
 */
export function useDockMode(): [DockMode, (mode: DockMode) => void] {
  const [mode, setModeState] = useState<DockMode>(readDockMode);

  useEffect(() => {
    const onChange = () => setModeState(readDockMode());
    window.addEventListener(DOCK_EVENT, onChange);
    return () => window.removeEventListener(DOCK_EVENT, onChange);
  }, []);

  const setMode = useCallback((next: DockMode) => {
    try { localStorage.setItem(DOCK_KEY, next); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent(DOCK_EVENT));
  }, []);

  return [mode, setMode];
}
