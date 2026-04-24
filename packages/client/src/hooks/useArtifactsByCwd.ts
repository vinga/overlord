import { useState, useEffect, useCallback, useRef } from 'react';
import type { Artifact, ArtifactKind } from '../types';

interface ArtifactChangedDetail {
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}

export interface UseArtifactsByCwdResult {
  artifacts: Artifact[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useArtifactsByCwd(cwd: string | undefined, kind?: ArtifactKind): UseArtifactsByCwdResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchArtifacts = useCallback(async () => {
    if (!cwd) {
      setArtifacts([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cwd });
      if (kind) params.set('kind', kind);
      const res = await fetch(`/api/artifacts?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { artifacts: Artifact[] };
      if (mountedRef.current) setArtifacts(sortArtifacts(data.artifacts ?? []));
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [cwd, kind]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchArtifacts();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchArtifacts]);

  useEffect(() => {
    if (!cwd) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ArtifactChangedDetail>).detail;
      if (detail?.cwd !== cwd) return;
      if (kind && detail.kind !== kind) return;
      void fetchArtifacts();
    };
    window.addEventListener('artifact:changed', onChange);
    return () => window.removeEventListener('artifact:changed', onChange);
  }, [cwd, kind, fetchArtifacts]);

  return { artifacts, isLoading, error, refetch: fetchArtifacts };
}
