import { useState, useEffect, useCallback, useRef } from 'react';
import type { Artifact, ArtifactKind, ArtifactStatus } from '../types';

interface ArtifactChangedDetail {
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}

interface CreateArtifactInput {
  title?: string;
  body?: string;
  status?: ArtifactStatus;
  cwd?: string;
  kind?: ArtifactKind;
}

interface UpdateArtifactInput {
  title?: string;
  body?: string;
  status?: ArtifactStatus;
}

export interface UseArtifactsResult {
  artifacts: Artifact[];
  isLoading: boolean;
  error: string | null;
  createArtifact: (input?: CreateArtifactInput) => Promise<Artifact | null>;
  updateArtifact: (artifactId: string, input: UpdateArtifactInput) => Promise<Artifact | null>;
  deleteArtifact: (artifactId: string) => Promise<boolean>;
  refetch: () => void;
}

function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useArtifacts(overlordId: string | undefined, kind?: ArtifactKind): UseArtifactsResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchArtifacts = useCallback(async () => {
    if (!overlordId) {
      setArtifacts([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ overlordId });
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
  }, [overlordId, kind]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchArtifacts();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchArtifacts]);

  useEffect(() => {
    if (!overlordId) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ArtifactChangedDetail>).detail;
      if (detail?.overlordId !== overlordId) return;
      if (kind && detail.kind !== kind) return;
      void fetchArtifacts();
    };
    window.addEventListener('artifact:changed', onChange);
    return () => window.removeEventListener('artifact:changed', onChange);
  }, [overlordId, kind, fetchArtifacts]);

  const createArtifact = useCallback(
    async (input?: CreateArtifactInput): Promise<Artifact | null> => {
      if (!overlordId) return null;
      try {
        const body = { overlordId, kind: kind ?? input?.kind ?? 'plan', ...input };
        const res = await fetch('/api/artifacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { artifact: Artifact };
        return data.artifact;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [overlordId, kind],
  );

  const updateArtifact = useCallback(
    async (artifactId: string, input: UpdateArtifactInput): Promise<Artifact | null> => {
      try {
        const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { artifact: Artifact };
        return data.artifact;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  const deleteArtifact = useCallback(async (artifactId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  return { artifacts, isLoading, error, createArtifact, updateArtifact, deleteArtifact, refetch: fetchArtifacts };
}
