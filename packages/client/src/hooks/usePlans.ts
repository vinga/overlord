import { useState, useEffect, useCallback, useRef } from 'react';
import type { Plan, PlanStatus } from '../types';

interface PlanChangedDetail {
  planId: string;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}

interface CreatePlanInput {
  title?: string;
  body?: string;
  status?: PlanStatus;
  cwd?: string;
}

interface UpdatePlanInput {
  title?: string;
  body?: string;
  status?: PlanStatus;
}

export interface UsePlansResult {
  plans: Plan[];
  isLoading: boolean;
  error: string | null;
  createPlan: (input?: CreatePlanInput) => Promise<Plan | null>;
  updatePlan: (planId: string, input: UpdatePlanInput) => Promise<Plan | null>;
  deletePlan: (planId: string) => Promise<boolean>;
  refetch: () => void;
}

function sortPlans(plans: Plan[]): Plan[] {
  return [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function usePlans(overlordId: string | undefined): UsePlansResult {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchPlans = useCallback(async () => {
    if (!overlordId) {
      setPlans([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans?overlordId=${encodeURIComponent(overlordId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { plans: Plan[] };
      if (mountedRef.current) setPlans(sortPlans(data.plans ?? []));
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [overlordId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchPlans();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchPlans]);

  useEffect(() => {
    if (!overlordId) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<PlanChangedDetail>).detail;
      if (detail?.overlordId === overlordId) void fetchPlans();
    };
    window.addEventListener('plan:changed', onChange);
    return () => window.removeEventListener('plan:changed', onChange);
  }, [overlordId, fetchPlans]);

  const createPlan = useCallback(
    async (input?: CreatePlanInput): Promise<Plan | null> => {
      if (!overlordId) return null;
      try {
        const res = await fetch('/api/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overlordId, ...input }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { plan: Plan };
        return data.plan;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [overlordId],
  );

  const updatePlan = useCallback(
    async (planId: string, input: UpdatePlanInput): Promise<Plan | null> => {
      try {
        const res = await fetch(`/api/plans/${encodeURIComponent(planId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { plan: Plan };
        return data.plan;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [],
  );

  const deletePlan = useCallback(async (planId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(planId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, []);

  return { plans, isLoading, error, createPlan, updatePlan, deletePlan, refetch: fetchPlans };
}
