import { useState, useEffect, useCallback, useRef } from 'react';
import type { Plan } from '../types';

interface PlanChangedDetail {
  planId: string;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}

export interface UsePlansByCwdResult {
  plans: Plan[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

function sortPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function usePlansByCwd(cwd: string | undefined): UsePlansByCwdResult {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchPlans = useCallback(async () => {
    if (!cwd) {
      setPlans([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { plans: Plan[] };
      if (mountedRef.current) setPlans(sortPlans(data.plans ?? []));
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchPlans();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchPlans]);

  useEffect(() => {
    if (!cwd) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<PlanChangedDetail>).detail;
      if (detail?.cwd === cwd) void fetchPlans();
    };
    window.addEventListener('plan:changed', onChange);
    return () => window.removeEventListener('plan:changed', onChange);
  }, [cwd, fetchPlans]);

  return { plans, isLoading, error, refetch: fetchPlans };
}
