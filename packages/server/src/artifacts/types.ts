export type ArtifactStatus = 'draft' | 'active' | 'done' | 'archived';
export type ArtifactSource = 'claude' | 'user';
export type ArtifactKind = 'plan' | 'summary' | 'compact';

export interface ArtifactMeta {
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: ArtifactStatus;
  source: ArtifactSource;
  claudePlanToolUseId?: string;
}

export interface Artifact extends ArtifactMeta {
  body: string;
}

export interface ArtifactChangedEvent {
  type: 'artifact:changed';
  artifactId: string;
  kind: ArtifactKind;
  overlordId: string;
  cwd: string;
  op: 'create' | 'update' | 'delete';
}
