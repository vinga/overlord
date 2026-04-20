export type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
export type PlanSource = 'claude' | 'user';

export interface PlanMeta {
  planId: string;
  overlordId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: PlanStatus;
  source: PlanSource;
  claudePlanToolUseId?: string;
}

export interface Plan extends PlanMeta {
  body: string;
}

export interface PlanChangedEvent {
  type: 'plan:changed';
  planId: string;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}
