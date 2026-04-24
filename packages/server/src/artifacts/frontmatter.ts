import type { Artifact, ArtifactMeta, ArtifactStatus, ArtifactSource, ArtifactKind } from './types.js';

const REQUIRED_FIELDS = [
  'artifactId',
  'kind',
  'overlordId',
  'cwd',
  'createdAt',
  'updatedAt',
  'title',
  'status',
  'source',
] as const;

const VALID_STATUSES: ArtifactStatus[] = ['draft', 'active', 'done', 'archived'];
const VALID_SOURCES: ArtifactSource[] = ['claude', 'user'];
const VALID_KINDS: ArtifactKind[] = ['plan', 'summary', 'compact'];

export interface ParseResult {
  ok: true;
  artifact: Artifact;
}

export interface ParseError {
  ok: false;
  reason: string;
}

export function parseArtifactFile(text: string): ParseResult | ParseError {
  if (!text.startsWith('---')) {
    return { ok: false, reason: 'missing opening --- delimiter' };
  }

  const rest = text.slice(3);
  const nlAfterOpen = rest.indexOf('\n');
  if (nlAfterOpen === -1) return { ok: false, reason: 'malformed frontmatter' };

  const closeIdx = rest.indexOf('\n---', nlAfterOpen);
  if (closeIdx === -1) return { ok: false, reason: 'missing closing --- delimiter' };

  const metaBlock = rest.slice(nlAfterOpen + 1, closeIdx);
  const afterClose = rest.slice(closeIdx + 4);
  // Serializer writes `---\n\n{body}` — strip the closing `\n` plus the blank-line separator.
  const body = afterClose.replace(/^\n\n?/, '');

  const raw: Record<string, string> = {};
  for (const line of metaBlock.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    raw[key] = decodeValue(rawValue);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!raw[field]) return { ok: false, reason: `missing required field: ${field}` };
  }

  const status = raw.status as ArtifactStatus;
  if (!VALID_STATUSES.includes(status)) {
    return { ok: false, reason: `invalid status: ${raw.status}` };
  }

  const source = raw.source as ArtifactSource;
  if (!VALID_SOURCES.includes(source)) {
    return { ok: false, reason: `invalid source: ${raw.source}` };
  }

  const kind = raw.kind as ArtifactKind;
  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, reason: `invalid kind: ${raw.kind}` };
  }

  const meta: ArtifactMeta = {
    artifactId: raw.artifactId,
    kind,
    overlordId: raw.overlordId,
    cwd: raw.cwd,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    title: raw.title,
    status,
    source,
    claudePlanToolUseId: raw.claudePlanToolUseId || undefined,
  };

  return { ok: true, artifact: { ...meta, body } };
}

export function serializeArtifactFile(artifact: Artifact): string {
  const fields: Array<[string, string | undefined]> = [
    ['artifactId', artifact.artifactId],
    ['kind', artifact.kind],
    ['overlordId', artifact.overlordId],
    ['cwd', artifact.cwd],
    ['createdAt', artifact.createdAt],
    ['updatedAt', artifact.updatedAt],
    ['title', artifact.title],
    ['status', artifact.status],
    ['source', artifact.source],
    ['claudePlanToolUseId', artifact.claudePlanToolUseId],
  ];

  const lines = ['---'];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    lines.push(`${key}: ${encodeValue(value)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${artifact.body}`;
}

function decodeValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function encodeValue(value: string): string {
  if (/[\n\r"\\]/.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}
